const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const env = require("../config/env");

/**
 * Access tokens are short-lived JWTs -- stateless, verified on every
 * request without a DB hit.
 */
function signAccessToken({ role, id }) {
  return jwt.sign({ role, sub: id }, env.jwt.accessSecret, {
    expiresIn: env.jwt.accessTtl,
  });
}

function verifyAccessToken(token) {
  // Throws JsonWebTokenError / TokenExpiredError on failure -- caller decides
  // how to translate that into an HTTP response.
  return jwt.verify(token, env.jwt.accessSecret);
}

/**
 * Uses opaque, revocable tokens; only their SHA-256 hashes are stored.
 */
function generateOpaqueToken() {
  return crypto.randomBytes(48).toString("base64url");
}

function hashOpaqueToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  generateOpaqueToken,
  hashOpaqueToken,
};
