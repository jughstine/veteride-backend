const pool = require("../../../config/db");
const { hashOpaqueToken } = require("../../../utils/tokens");

// ---------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------

async function storeRefreshToken({
  rawToken,
  role,
  userId,
  expiresAt,
  createdIp = null,
}) {
  const tokenHash = hashOpaqueToken(rawToken);
  await pool.query(
    `INSERT INTO auth_refresh_tokens (token_hash, user_role, user_id, expires_at, created_ip)
     VALUES (:tokenHash, :role, :userId, :expiresAt, :createdIp)`,
    { tokenHash, role, userId, expiresAt, createdIp },
  );
  return tokenHash;
}

/** Only returns a token that is unrevoked & unexpired. */
async function findActiveRefreshToken(rawToken) {
  const tokenHash = hashOpaqueToken(rawToken);
  const [rows] = await pool.query(
    `SELECT * FROM auth_refresh_tokens
     WHERE token_hash = :tokenHash AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    { tokenHash },
  );
  return rows[0] || null;
}

async function revokeRefreshTokenByHash(tokenHash, replacedByTokenHash = null) {
  await pool.query(
    `UPDATE auth_refresh_tokens
     SET revoked_at = NOW(), replaced_by_token_hash = :replacedByTokenHash
     WHERE token_hash = :tokenHash AND revoked_at IS NULL`,
    { tokenHash, replacedByTokenHash },
  );
}

async function revokeRefreshTokenByRawToken(rawToken) {
  const tokenHash = hashOpaqueToken(rawToken);
  await revokeRefreshTokenByHash(tokenHash);
}

/** password reset ; existing sessions for account dies. */
async function revokeAllRefreshTokensForUser(role, userId) {
  await pool.query(
    `UPDATE auth_refresh_tokens
     SET revoked_at = NOW()
     WHERE user_role = :role AND user_id = :userId AND revoked_at IS NULL`,
    { role, userId },
  );
}

// ---------------------------------------------------------------------
// Password reset tokens
// ---------------------------------------------------------------------

async function storePasswordResetToken({ rawToken, role, userId, expiresAt }) {
  const tokenHash = hashOpaqueToken(rawToken);
  await pool.query(
    `INSERT INTO auth_password_reset_tokens (token_hash, user_role, user_id, expires_at)
     VALUES (:tokenHash, :role, :userId, :expiresAt)`,
    { tokenHash, role, userId, expiresAt },
  );
}

/** Only returns a token that is unused & unexpired. */
async function findActivePasswordResetToken(rawToken) {
  const tokenHash = hashOpaqueToken(rawToken);
  const [rows] = await pool.query(
    `SELECT * FROM auth_password_reset_tokens
     WHERE token_hash = :tokenHash AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    { tokenHash },
  );
  return rows[0] || null;
}

async function markPasswordResetTokenUsed(tokenHash) {
  await pool.query(
    "UPDATE auth_password_reset_tokens SET used_at = NOW() WHERE token_hash = :tokenHash",
    { tokenHash },
  );
}

module.exports = {
  storeRefreshToken,
  findActiveRefreshToken,
  revokeRefreshTokenByHash,
  revokeRefreshTokenByRawToken,
  revokeAllRefreshTokensForUser,
  storePasswordResetToken,
  findActivePasswordResetToken,
  markPasswordResetTokenUsed,
};
