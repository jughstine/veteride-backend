const { randomUUID } = require("crypto");
const pool = require("../../../config/db");

/**
 * Where a handset's push address is kept.
 *
 * Without a row in here the server cannot address a phone at all, and a
 * driver whose app is not open and in front receives NOTHING: no booking
 * offer, no sound. Both of the existing paths need the app running — the
 * offer poll armed when a driver goes on duty, and the SSE stream in
 * realtime/stream.js. This table is the only thing that reaches a pocket.
 *
 * See migrations/015_device_tokens.sql and docs/the-sql-that-is-left.md.
 */

/**
 * Records this handset against this account, replacing whatever was there.
 *
 * KEYED ON THE TOKEN ALONE, which is what device_tokens_token_uk is for. A
 * handset passed to another driver must MOVE to the new account rather than
 * ring for both: unique per user would leave the old row in place and send
 * that driver's offers to somebody else's phone.
 *
 * The app posts on every sign-in and every session restore, so this runs
 * often and has to be idempotent. One statement, no read first.
 */
async function saveToken({ userId, role, token, platform }) {
  await pool.query(
    `INSERT INTO device_tokens (token_id, user_id, role, token, platform)
     VALUES (:tokenId, :userId, :role, :token, :platform)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       role = VALUES(role),
       platform = VALUES(platform),
       updated_at = CURRENT_TIMESTAMP`,
    {
      tokenId: randomUUID(),
      userId,
      role,
      token,
      platform: platform || "android",
    },
  );
}

/**
 * Every phone that must ring for this account.
 *
 * Runs on every notification, which is why device_tokens_user_idx exists.
 * A driver with two handsets gets two rows and both ring — deliberate, not
 * an edge case: a phone left charging at home is the usual reason a driver
 * misses work.
 */
async function tokensFor(userId, role) {
  const [rows] = await pool.query(
    `SELECT token FROM device_tokens
      WHERE user_id = :userId AND role = :role`,
    { userId, role },
  );
  return rows.map((row) => row.token);
}

/**
 * Forgets a handset FCM has told us is gone.
 *
 * Call this the moment a send comes back UNREGISTERED or NOT_FOUND — the app
 * has been uninstalled or its data cleared, and that token will never work
 * again. A table that only grows means every notification costs more over
 * time, and eventually most sends go to phones that no longer exist. It
 * degrades slowly enough that nobody notices until the latency does.
 */
async function dropToken(token) {
  await pool.query(`DELETE FROM device_tokens WHERE token = :token`, { token });
}

module.exports = { saveToken, tokensFor, dropToken };
