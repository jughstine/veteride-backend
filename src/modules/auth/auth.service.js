const AppError = require("../../utils/AppError");
const env = require("../../config/env");
const { hashPassword, comparePassword } = require("../../utils/password");
const { signAccessToken, generateOpaqueToken } = require("../../utils/tokens");
const { verifyGoogleIdToken } = require("./google.client");
const { getRoleConfig } = require("./repositories/role-tables");
const userRepo = require("./repositories/user.repository");
const tokenRepo = require("./repositories/token.repository");
const emailCodeRepo = require("./repositories/email-code.repository");
const mailer = require("../../utils/mailer");
const { buildSignInCodeEmail } = require("./sign-in-code.email");
const {
  generateCode,
  hashCode,
  hashesMatch,
} = require("../../utils/email-code");
const logger = require("../../utils/logger");

function addDays(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function addMinutes(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function stripSensitive(userRow) {
  const { password_hash, ...safe } = userRow;
  return safe;
}

/**
 * Creates and persists an access+refresh token pair for all session flows.
 */
async function issueSession(role, userId, ip) {
  const accessToken = signAccessToken({ role, id: userId });

  const refreshToken = generateOpaqueToken();
  const expiresAt = addDays(env.refreshToken.ttlDays);
  await tokenRepo.storeRefreshToken({
    rawToken: refreshToken,
    role,
    userId,
    expiresAt,
    createdIp: ip,
  });

  return { accessToken, refreshToken };
}

// POST /auth/register
// Shared registration for riders and drivers; both create active accounts
// and receive a session immediately. Driver verification is completed later
// and only gates driver-specific operations.
async function register(payload, ip) {
  if (payload.role === "driver") {
    return registerDriver(payload, ip);
  }
  return registerRider(payload, ip);
}

async function registerRider({ fullName, email, phone, password }, ip) {
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await userRepo.findByEmailForRole("rider", normalizedEmail);
  if (existing) {
    throw new AppError(
      409,
      "EMAIL_TAKEN",
      "An account with this email already exists",
    );
  }

  if (await userRepo.isPhoneTaken(phone)) {
    throw new AppError(
      409,
      "PHONE_TAKEN",
      "An account with this phone number already exists",
    );
  }

  const passwordHash = await hashPassword(password);
  const rider = await userRepo.createRider({
    fullName,
    email: normalizedEmail,
    phone,
    passwordHash,
  });

  const session = await issueSession("rider", rider.user_id, ip);
  return {
    status: "signed_in",
    user: stripSensitive(rider),
    role: "rider",
    ...session,
  };
}

async function registerDriver({ fullName, email, phone, password }, ip) {
  const normalizedEmail = email.toLowerCase().trim();

  const existing = await userRepo.findByEmailForRole("driver", normalizedEmail);
  if (existing) {
    throw new AppError(
      409,
      "EMAIL_TAKEN",
      "An account with this email already exists",
    );
  }

  // Cross-role, same as rider signup: a phone claimed by a rider can't
  // also be claimed by a driver.
  if (await userRepo.isPhoneTaken(phone)) {
    throw new AppError(
      409,
      "PHONE_TAKEN",
      "An account with this phone number already exists",
    );
  }

  const passwordHash = await hashPassword(password);
  const driver = await userRepo.createDriverApplicant({
    fullName,
    email: normalizedEmail,
    phone,
    passwordHash,
  });

  const session = await issueSession("driver", driver.driver_id, ip);
  return {
    status: "signed_in",
    user: stripSensitive(driver),
    role: "driver",
    ...session,
  };
}

// POST /auth/login
// Role-scoped login: only the table mapped to the requested role is queried,
// so accounts from other roles cannot open a session.
async function login({ role, identifier, password }, ip) {
  const cfg = getRoleConfig(role);
  if (!cfg) {
    throw new AppError(400, "INVALID_ROLE", "Unknown role");
  }

  const account = await userRepo.findByIdentifierForRole(
    role,
    identifier.toLowerCase().trim(),
  );

  // Same error for missing accounts and wrong passwords to prevent enumeration.
  const invalidCredentialsError = () =>
    new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");

  if (!account) throw invalidCredentialsError();

  const passwordMatches = await comparePassword(
    password,
    account.password_hash,
  );
  if (!passwordMatches) throw invalidCredentialsError();

  if (account.status && account.status !== "active") {
    throw new AppError(
      403,
      "ACCOUNT_NOT_ACTIVE",
      `Account is ${account.status}`,
    );
  }

  // No verification check here; drivers can log in before approval.
  // Verification only gates driver-specific operations.
  const idValue = account[cfg.idColumn];
  const session = await issueSession(role, idValue, ip);
  return {
    status: "signed_in",
    user: stripSensitive(account),
    role,
    ...session,
  };
}

// POST /auth/google
// Determines sign-in status from the database; new Google identities
// are not auto-created and must provide a phone number first.
async function googleSignIn({ idToken }, ip) {
  const { googleId, email, fullName } = await verifyGoogleIdToken(idToken);

  let rider = await userRepo.findRiderByGoogleId(googleId);

  if (!rider) {
    // Same person may have registered normally with this email before
    // ever using "Sign in with Google" -- link rather than duplicate.
    const existingByEmail = await userRepo.findRiderByEmail(email);
    if (existingByEmail) {
      await userRepo.linkGoogleIdToRider(existingByEmail.user_id, googleId);
      rider = await userRepo.findByIdForRole("rider", existingByEmail.user_id);
    }
  }

  if (!rider) {
    return { status: "needs_phone", email, fullName };
  }

  if (rider.status !== "active") {
    throw new AppError(403, "ACCOUNT_NOT_ACTIVE", `Account is ${rider.status}`);
  }

  const session = await issueSession("rider", rider.user_id, ip);
  return {
    status: "signed_in",
    user: stripSensitive(rider),
    role: "rider",
    ...session,
  };
}

// POST /auth/google/complete
// Re-verifies the Google ID token and collects a unique phone number
// before creating the rider account.
async function googleComplete({ idToken, phone }, ip) {
  const { googleId, email, fullName } = await verifyGoogleIdToken(idToken);

  // Idempotency: if this identity (or email) already resolved to an
  // account between the two calls, just sign them in instead of erroring.
  let rider = await userRepo.findRiderByGoogleId(googleId);
  if (!rider) rider = await userRepo.findRiderByEmail(email);

  if (rider) {
    if (!rider.google_id)
      await userRepo.linkGoogleIdToRider(rider.user_id, googleId);
    const session = await issueSession("rider", rider.user_id, ip);
    return {
      status: "signed_in",
      user: stripSensitive(rider),
      role: "rider",
      ...session,
    };
  }

  if (await userRepo.isPhoneTaken(phone)) {
    throw new AppError(
      409,
      "PHONE_TAKEN",
      "This phone number is already registered",
    );
  }

  rider = await userRepo.createRider({
    fullName: fullName || "Rider",
    email,
    phone,
    passwordHash: null,
    googleId,
    emailVerified: true,
  });

  const session = await issueSession("rider", rider.user_id, ip);
  return {
    status: "signed_in",
    user: stripSensitive(rider),
    role: "rider",
    ...session,
  };
}

// POST /auth/refresh
// Rotates the refresh token; the old token is revoked when its replacement is issued.
async function refresh({ refreshToken }, ip) {
  const tokenRow = await tokenRepo.findActiveRefreshToken(refreshToken);
  if (!tokenRow) {
    throw new AppError(
      401,
      "INVALID_REFRESH_TOKEN",
      "Refresh token is invalid or expired",
    );
  }

  const account = await userRepo.findByIdForRole(
    tokenRow.user_role,
    tokenRow.user_id,
  );
  if (!account || (account.status && account.status !== "active")) {
    throw new AppError(
      401,
      "ACCOUNT_NOT_USABLE",
      "Account is no longer usable",
    );
  }

  const newAccessToken = signAccessToken({
    role: tokenRow.user_role,
    id: tokenRow.user_id,
  });

  const newRefreshToken = generateOpaqueToken();
  const newExpiresAt = addDays(env.refreshToken.ttlDays);
  const newTokenHash = await tokenRepo.storeRefreshToken({
    rawToken: newRefreshToken,
    role: tokenRow.user_role,
    userId: tokenRow.user_id,
    expiresAt: newExpiresAt,
    createdIp: ip,
  });

  await tokenRepo.revokeRefreshTokenByHash(tokenRow.token_hash, newTokenHash);

  return {
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    role: tokenRow.user_role,
  };
}

// POST /auth/logout
// Revokes the refresh token server-side. Idempotent even if already revoked or unknown.
async function logout({ refreshToken }) {
  await tokenRepo.revokeRefreshTokenByRawToken(refreshToken);
}

// POST /auth/password/forgot
// Always returns 202 to prevent revealing whether the account exists.
async function forgotPassword({ role, identifier }) {
  const cfg = getRoleConfig(role);
  if (!cfg) return; // still swallow -- do not reveal role validity either

  const account = await userRepo.findByIdentifierForRole(
    role,
    identifier.toLowerCase().trim(),
  );
  if (!account) return;

  const rawToken = generateOpaqueToken();
  const expiresAt = addMinutes(env.passwordReset.ttlMinutes);
  await tokenRepo.storePasswordResetToken({
    rawToken,
    role,
    userId: account[cfg.idColumn],
    expiresAt,
  });

  // TODO: wire up a real email/SMS provider. Logging in place of sending
  // so the flow is exercisable end-to-end in the meantime -- the raw
  // token must never be logged in production.
  if (env.nodeEnv !== "production") {
    logger.debug("Password reset token generated (dev only)", {
      role,
      identifier,
      rawToken,
    });
  } else {
    logger.info("Password reset requested", {
      role,
      userId: account[cfg.idColumn],
    });
  }
}

// ---------------------------------------------------------------------
// POST /auth/password/reset
// ---------------------------------------------------------------------
async function resetPassword({ token, newPassword }) {
  const tokenRow = await tokenRepo.findActivePasswordResetToken(token);
  if (!tokenRow) {
    throw new AppError(
      400,
      "INVALID_OR_EXPIRED_TOKEN",
      "Reset token is invalid or expired",
    );
  }

  const passwordHash = await hashPassword(newPassword);
  await userRepo.updatePasswordForRole(
    tokenRow.user_role,
    tokenRow.user_id,
    passwordHash,
  );
  await tokenRepo.markPasswordResetTokenUsed(tokenRow.token_hash);

  // A password reset means every existing session is suspect -- kill them all.
  await tokenRepo.revokeAllRefreshTokensForUser(
    tokenRow.user_role,
    tokenRow.user_id,
  );
}

// ---------------------------------------------------------------------
// POST /auth/email-code
// ---------------------------------------------------------------------
// Mails six digits to the address on the account, and says the same thing
// however that went.
//
// The 202 is unconditional for a reason. "No such account" here would be a
// free directory of everybody who has ever signed up: an attacker types a
// list of addresses at it and keeps the ones that come back different. So
// an unknown identifier, an account with no e-mail on it, and a suspended
// account all take the same quiet path as a successful send -- the only
// thing that varies is whether a message was actually posted, which the
// caller cannot observe.
//
// The one refusal this route does make is about ITSELF, not about the
// account: with no SMTP settings there is nothing to send with, and that is
// checked BEFORE the account is looked up, so the 503 is identical for a
// real address and an invented one.
async function requestEmailCode({ role, identifier }, ip) {
  if (!mailer.isConfigured()) {
    throw new AppError(
      503,
      "EMAIL_NOT_CONFIGURED",
      "Sign-in codes are unavailable: this server has no mail settings",
    );
  }

  const cfg = getRoleConfig(role);
  if (!cfg) return; // swallowed, like forgotPassword: do not confirm role validity

  const account = await userRepo.findByIdentifierForRole(
    role,
    identifier.toLowerCase().trim(),
  );
  if (!account) return;

  // A suspended or deactivated account cannot open a session (login refuses
  // it), so mailing it a code would be an invitation to nothing. Silent
  // rather than refused: saying "that account is suspended" to an
  // unauthenticated caller is the same oracle in a different coat.
  if (account.status && account.status !== "active") return;

  // An account somehow without an address has nowhere to send to. Not an
  // error -- the caller must not learn the difference.
  if (!account.email) return;

  const userId = account[cfg.idColumn];
  const code = generateCode();
  const ttlMinutes = env.emailCode.ttlMinutes;

  // Stored first, sent second. The other order would let a message arrive
  // carrying a code the database has never heard of.
  await emailCodeRepo.upsertEmailCode({
    role,
    userId,
    codeHash: hashCode({ role, userId, code }),
    expiresAt: addMinutes(ttlMinutes),
    requestedIp: ip || null,
  });

  const message = buildSignInCodeEmail({ code, ttlMinutes });

  try {
    await mailer.sendMail({
      to: account.email,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (err) {
    // The code cannot be delivered, so it is withdrawn rather than left
    // pending: the person would otherwise be staring at a "we sent you a
    // code" screen with a live code in a mailbox it never reached.
    //
    // Still a 202 to the caller. A 502 here would be the enumeration oracle
    // again by the back door -- an invented address returns 202 and a real
    // one returns 502 the moment the relay is unwell. The failure belongs
    // in the server's log, where the owner is the one who reads it.
    await emailCodeRepo.deleteEmailCode({ role, userId });
    logger.error("Sign-in code e-mail failed to send", {
      role,
      userId,
      reason: err.message,
    });
  }

  // Nothing is returned, and nothing ever could be: `code` goes out of
  // scope here and was never written to a log, a response, or the database
  // in the clear.
}

// ---------------------------------------------------------------------
// POST /auth/email-code/verify
// ---------------------------------------------------------------------
// Spends the code and answers EXACTLY what login answers, so the app adopts
// the session through the code path it already has.
//
// Two refusals, and the split is deliberate:
//
//   INVALID_EMAIL_CODE             the digits were wrong, and here is how
//                                  many guesses are left on this code.
//   EMAIL_CODE_INVALID_OR_EXPIRED  there is nothing to guess at: expired,
//                                  already spent, out of attempts, never
//                                  asked for, or no such account. One
//                                  answer for all five, because telling
//                                  them apart is telling the caller which
//                                  accounts exist.
//
// The narrow seam that remains: a caller who FIRST triggers a code for an
// address -- which mails the real owner and is capped at five an hour --
// can tell the two refusals apart afterwards and so learn the account
// exists. Closing it entirely would mean minting decoy rows for addresses
// with no account behind them; the attempts-left counter the app needs to
// say "2 tries left" is the trade, and it costs the attacker a noisy,
// throttled e-mail to a stranger for every address they test.
async function verifyEmailCode({ role, identifier, code }, ip) {
  const cfg = getRoleConfig(role);

  const notValidError = () =>
    new AppError(
      401,
      "EMAIL_CODE_INVALID_OR_EXPIRED",
      "That sign-in code is not valid. Request a new one.",
    );

  if (!cfg) throw notValidError();

  const account = await userRepo.findByIdentifierForRole(
    role,
    identifier.toLowerCase().trim(),
  );
  if (!account) throw notValidError();

  const userId = account[cfg.idColumn];
  const maxAttempts = env.emailCode.maxAttempts;

  // One predicate covers unspent, unexpired and attempts-remaining, so all
  // three arrive here as the same null.
  const pending = await emailCodeRepo.findLiveEmailCode({
    role,
    userId,
    maxAttempts,
  });
  if (!pending) throw notValidError();

  // The role and the id are inside the hash, so a code minted for a driver
  // hashes to something else when it is offered as a rider's -- belt and
  // braces over the (user_role, user_id) key that already scoped the read.
  const offered = hashCode({ role, userId, code });

  if (!hashesMatch(offered, pending.code_hash)) {
    const attemptsRemaining = await emailCodeRepo.recordFailedAttempt({
      role,
      userId,
      maxAttempts,
    });
    throw new AppError(
      401,
      "INVALID_EMAIL_CODE",
      attemptsRemaining > 0
        ? "That code is not right."
        : "That code is not right, and it has no attempts left. Request a new one.",
      { attempts_remaining: attemptsRemaining },
    );
  }

  // Spent by the UPDATE itself, not by a read followed by a write: two
  // requests carrying the same correct code both reach this line, and only
  // the one that changes a row is allowed to mint a session.
  const consumed = await emailCodeRepo.consumeEmailCode({
    role,
    userId,
    codeHash: offered,
  });
  if (!consumed) throw notValidError();

  // Checked after the code is spent, and answered plainly: this caller has
  // proved they read the account's mail, so they are owed the real reason.
  // Login says the same thing in the same words.
  if (account.status && account.status !== "active") {
    throw new AppError(
      403,
      "ACCOUNT_NOT_ACTIVE",
      `Account is ${account.status}`,
    );
  }

  const session = await issueSession(role, userId, ip);
  return {
    status: "signed_in",
    user: stripSensitive(account),
    role,
    ...session,
  };
}

module.exports = {
  register,
  login,
  googleSignIn,
  googleComplete,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  requestEmailCode,
  verifyEmailCode,
};
