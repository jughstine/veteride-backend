const AppError = require("../../utils/AppError");
const env = require("../../config/env");
const { hashPassword, comparePassword } = require("../../utils/password");
const { signAccessToken, generateOpaqueToken } = require("../../utils/tokens");
const { verifyGoogleIdToken } = require("./google.client");
const { getRoleConfig } = require("./repositories/role-tables");
const userRepo = require("./repositories/user.repository");
const tokenRepo = require("./repositories/token.repository");
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

module.exports = {
  register,
  login,
  googleSignIn,
  googleComplete,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
};
