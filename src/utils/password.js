const bcrypt = require("bcryptjs");
const env = require("../config/env");

async function hashPassword(plain) {
  return bcrypt.hash(plain, env.bcryptSaltRounds);
}

/**
 * Returns false for null hashes, allowing safe password comparisons.
 */
async function comparePassword(plain, storedHash) {
  if (!storedHash) return false;
  return bcrypt.compare(plain, storedHash);
}

module.exports = { hashPassword, comparePassword };
