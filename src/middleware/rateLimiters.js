const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many login attempts. Try again later.",
    },
  },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many sign-up attempts. Try again later.",
    },
  },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "Too many requests. Try again later.",
    },
  },
});

const googleLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------
// Emailed sign-in codes
// ---------------------------------------------------------------------
// Two limits on each of the two routes, because the two abuses are
// different people. Limiting only the CALLER lets one host mail codes to a
// thousand addresses; limiting only the IDENTIFIER lets a botnet hammer one
// account from a thousand hosts. Express-rate-limit keys on one value at a
// time, so each route carries one of each, chained.

/** The address the request came from. */
const byCaller = (req) => ipKeyGenerator(req.ip);

/**
 * The ACCOUNT being asked about, lower-cased and trimmed exactly as
 * auth.service.js will look it up — otherwise "Ann@x.com" and "ann@x.com "
 * are two budgets for one mailbox. The role is in the key because rider and
 * driver accounts are separate accounts even on one address.
 *
 * Falls back to the caller's address when there is no identifier to read,
 * so a malformed body still spends someone's budget rather than none.
 */
const byIdentifier = (req) => {
  const role = typeof req.body?.role === "string" ? req.body.role : "?";
  const identifier =
    typeof req.body?.identifier === "string"
      ? req.body.identifier.toLowerCase().trim()
      : "";
  return identifier ? `${role}:${identifier}` : byCaller(req);
};

const tooManyCodes = {
  error: {
    code: "RATE_LIMITED",
    message: "Too many sign-in code requests. Try again later.",
  },
};

const tooManyAttempts = {
  error: {
    code: "RATE_LIMITED",
    message: "Too many sign-in code attempts. Try again later.",
  },
};

/**
 * Asking for a code, per mailbox. FIVE an hour, matching the forgot-password
 * allowance next door: this route puts mail in somebody's inbox without
 * their asking, so the limit is as much about not being the instrument of
 * an e-mail flood as about not being brute-forced.
 */
const emailCodeRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: byIdentifier,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyCodes,
});

/**
 * Asking for a code, per caller. Higher than the per-mailbox limit because
 * a household, an office or a carrier NAT is one address and many people,
 * but far below what a script would want.
 */
const emailCodeRequestIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: byCaller,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyCodes,
});

/**
 * Offering a code, per account. The five-attempt counter on the code itself
 * is the real wall; this is the one that stops a script asking for a fresh
 * code every five guesses and grinding through the million that way.
 */
const emailCodeVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  keyGenerator: byIdentifier,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyAttempts,
});

/** Offering a code, per caller. Same shape as the login limiter. */
const emailCodeVerifyIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: byCaller,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyAttempts,
});

/* ── The authenticator ─────────────────────────────────────────────────
 *
 * The verify route is the one that matters: it is unauthenticated by
 * necessity (the sign-in has not finished), and six digits is a million
 * guesses. The per-account attempt count in auth_authenticators closes it
 * properly; this stops a caller working through accounts from one machine.
 */
const authenticatorVerifyIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: byCaller,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyAttempts,
});

// Enrolling is cheap but not free — each call mints a secret and replaces the
// pending row — and nobody legitimately starts setup twenty times an hour.
const authenticatorSetupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: byCaller,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooManyAttempts,
});

module.exports = {
  authenticatorVerifyIpLimiter,
  authenticatorSetupLimiter,
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  googleLimiter,
  emailCodeRequestLimiter,
  emailCodeRequestIpLimiter,
  emailCodeVerifyLimiter,
  emailCodeVerifyIpLimiter,
};
