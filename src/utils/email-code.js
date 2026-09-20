const crypto = require("crypto");
const env = require("../config/env");

/**
 * The six digits themselves: minting them, hashing them, and comparing a
 * guess against the hash.
 *
 * Kept away from the service so that the one rule that matters — the code
 * is never anywhere but the e-mail — is enforceable by reading one short
 * file. Nothing in here logs, and `generateCode` is the only function that
 * ever holds the digits.
 */

const CODE_DIGITS = 6;
const CODE_CEILING = 10 ** CODE_DIGITS; // 1_000_000

/**
 * A pepper derived from the server's signing secret, by HKDF-ish
 * domain separation so it is NOT the JWT key itself: the same secret used
 * for two jobs under one name is how one leak becomes two.
 *
 * Why a pepper at all — six digits is a million possibilities. A bare
 * SHA-256 of a six-digit code is reversible by anyone who reads the
 * auth_email_codes table, in about the time it takes to write the loop.
 * With a key they do not have, the stored hash is worth nothing on its own.
 *
 * Computed once at require time; env.jwt.accessSecret is already required
 * at boot, so this adds no new configuration.
 */
const PEPPER = crypto
  .createHmac("sha256", env.jwt.accessSecret)
  .update("veteride/email-sign-in-code/v1")
  .digest();

/**
 * Six digits from the CSPRNG. `crypto.randomInt` and not Math.random: the
 * latter is a predictable stream, and a predictable sign-in code is a
 * sign-in with no code.
 *
 * Leading zeros are kept — "000123" is a perfectly good code, and dropping
 * it would quietly shrink the space by a tenth.
 */
function generateCode() {
  return String(crypto.randomInt(0, CODE_CEILING)).padStart(CODE_DIGITS, "0");
}

/**
 * Binds the code to the ACCOUNT it was minted for, so the digits alone are
 * not a credential. The role and the id go into the message, which means a
 * code mailed to driver 7 hashes to something else entirely when it is
 * offered as rider 7's — a second lock on top of the primary key, for the
 * day somebody writes a lookup that forgets the role.
 */
function hashCode({ role, userId, code }) {
  return crypto
    .createHmac("sha256", PEPPER)
    .update(`${role}:${userId}:${code}`)
    .digest("hex");
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `a === b` on a string returns the moment two characters differ, and the
 * time it took to say no is a measurement of how much of the hash was
 * right. Over enough requests that is the hash. timingSafeEqual takes the
 * same time whatever the inputs — but it THROWS on unequal lengths, so the
 * length is checked first, and that check leaks nothing because both sides
 * are fixed-width digests of our own making.
 */
function hashesMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

module.exports = { generateCode, hashCode, hashesMatch, CODE_DIGITS };
