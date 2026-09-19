const pool = require("../../../config/db");

/**
 * The single pending sign-in code an account may have.
 *
 * Every read and write is keyed on (user_role, user_id) — the primary key of
 * auth_email_codes — so a second request REPLACES the first rather than
 * leaving two live codes behind.
 *
 * All of the clock arithmetic happens in SQL, never in JavaScript. The pool
 * is configured with `dateStrings: true` and a +08:00 session timezone, so a
 * DATETIME arrives here as a bare string with no offset; `new Date()` on it
 * would read it in the Node process's own timezone and could make an expired
 * code look live by hours. CURRENT_TIMESTAMP inside the statement compares
 * the two values in the same clock they were written in.
 */

/**
 * Mints or replaces this account's pending code.
 *
 * ON DUPLICATE KEY UPDATE, and it resets everything that belongs to the old
 * code: the previous hash stops working the instant this returns, the
 * attempt count goes back to zero, and a code that had already been spent no
 * longer counts as spent. Asking for a new code has to mean exactly that.
 *
 * Columns are assigned from the named parameters rather than VALUES(), which
 * MySQL 8.0.20 deprecated.
 */
async function upsertEmailCode({
  role,
  userId,
  codeHash,
  expiresAt,
  requestedIp = null,
}) {
  await pool.query(
    `INSERT INTO auth_email_codes
       (user_role, user_id, code_hash, expires_at, attempts, consumed_at, requested_ip)
     VALUES (:role, :userId, :codeHash, :expiresAt, 0, NULL, :requestedIp)
     ON DUPLICATE KEY UPDATE
       code_hash    = :codeHash,
       expires_at   = :expiresAt,
       attempts     = 0,
       consumed_at  = NULL,
       requested_ip = :requestedIp,
       created_at   = CURRENT_TIMESTAMP`,
    { role, userId, codeHash, expiresAt, requestedIp },
  );
}

/**
 * The code this account can still be asked about: unspent, unexpired, and
 * with guesses left.
 *
 * One predicate for all three, which is what makes the refusals
 * indistinguishable: the caller cannot tell an expired code from a spent one
 * from a code that never existed, because all four cases arrive here as
 * null.
 */
async function findLiveEmailCode({ role, userId, maxAttempts }) {
  const [rows] = await pool.query(
    `SELECT * FROM auth_email_codes
     WHERE user_role = :role
       AND user_id = :userId
       AND consumed_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP
       AND attempts < :maxAttempts
     LIMIT 1`,
    { role, userId, maxAttempts },
  );
  return rows[0] || null;
}

/**
 * Records one wrong guess and answers how many are left.
 *
 * The UPDATE carries the same liveness predicate as the read, so two wrong
 * guesses racing each other both count; and it touches `attempts` ONLY —
 * `expires_at` is not in the SET list, because a guess must never buy the
 * guesser more time.
 */
async function recordFailedAttempt({ role, userId, maxAttempts }) {
  const [result] = await pool.query(
    `UPDATE auth_email_codes
     SET attempts = attempts + 1
     WHERE user_role = :role
       AND user_id = :userId
       AND consumed_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP
       AND attempts < :maxAttempts`,
    { role, userId, maxAttempts },
  );

  if (result.affectedRows === 0) return 0;

  const [rows] = await pool.query(
    `SELECT attempts FROM auth_email_codes
     WHERE user_role = :role AND user_id = :userId LIMIT 1`,
    { role, userId },
  );
  const attempts = rows[0] ? Number(rows[0].attempts) : maxAttempts;
  return Math.max(0, maxAttempts - attempts);
}

/**
 * Spends the code, and says whether it was this caller who spent it.
 *
 * The whole check is the WHERE clause: right hash, not already consumed, not
 * expired. Two requests carrying the same correct code can both reach this
 * line, and MySQL will apply exactly one of them — the second matches no row
 * because consumed_at is no longer NULL. `affectedRows === 1` is therefore
 * the permission to mint a session, and checking the row first and updating
 * after would hand out two.
 */
async function consumeEmailCode({ role, userId, codeHash }) {
  const [result] = await pool.query(
    `UPDATE auth_email_codes
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE user_role = :role
       AND user_id = :userId
       AND code_hash = :codeHash
       AND consumed_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP`,
    { role, userId, codeHash },
  );
  return result.affectedRows === 1;
}

/** Drops a code that was minted but could not be delivered. */
async function deleteEmailCode({ role, userId }) {
  await pool.query(
    "DELETE FROM auth_email_codes WHERE user_role = :role AND user_id = :userId",
    { role, userId },
  );
}

module.exports = {
  upsertEmailCode,
  findLiveEmailCode,
  recordFailedAttempt,
  consumeEmailCode,
  deleteEmailCode,
};
