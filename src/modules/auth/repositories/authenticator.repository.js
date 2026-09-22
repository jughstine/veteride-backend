const pool = require("../../../config/db");

/**
 * The single TOTP authenticator an account may hold.
 *
 * Every read and write is keyed on (user_role, user_id) — the primary key of
 * auth_authenticators — so enrolling again REPLACES what was there rather
 * than leaving a second live secret behind.
 *
 * All clock arithmetic happens in SQL. The pool is `dateStrings: true` at
 * +08:00, so a DATETIME arrives here as a bare string with no offset and
 * `new Date()` on it would read it in the Node process's own timezone.
 */

/**
 * Starts, or restarts, an enrolment. `confirmed_at` is deliberately reset to
 * NULL: a new secret has not been proved to have reached anybody's phone yet,
 * and until it has it must not challenge a sign-in.
 */
async function upsertPending({ role, userId, secretSealed }) {
  await pool.query(
    `INSERT INTO auth_authenticators
       (user_role, user_id, secret_sealed, confirmed_at, last_used_at, failed_attempts)
     VALUES (:role, :userId, :secretSealed, NULL, NULL, 0)
     ON DUPLICATE KEY UPDATE
       secret_sealed   = :secretSealed,
       confirmed_at    = NULL,
       last_used_at    = NULL,
       failed_attempts = 0,
       created_at      = CURRENT_TIMESTAMP`,
    { role, userId, secretSealed },
  );
}

/** Whatever this account has, confirmed or not. Null when it has none. */
async function find({ role, userId }) {
  const [rows] = await pool.query(
    `SELECT * FROM auth_authenticators
     WHERE user_role = :role AND user_id = :userId
     LIMIT 1`,
    { role, userId },
  );
  return rows[0] || null;
}

/**
 * Arms it. Conditional on the row still being unconfirmed, so two taps of
 * "confirm" cannot both count as the first, and on the secret being the one
 * that was just confirmed against — if a second enrolment started in between,
 * this one no longer applies to anything.
 */
async function confirm({ role, userId, secretSealed }) {
  const [result] = await pool.query(
    `UPDATE auth_authenticators
     SET confirmed_at = CURRENT_TIMESTAMP,
         last_used_at = CURRENT_TIMESTAMP,
         failed_attempts = 0
     WHERE user_role = :role
       AND user_id = :userId
       AND secret_sealed = :secretSealed
       AND confirmed_at IS NULL`,
    { role, userId, secretSealed },
  );
  return result.affectedRows === 1;
}

/** A code was accepted: the count of wrong ones goes back to nothing. */
async function recordSuccess({ role, userId }) {
  await pool.query(
    `UPDATE auth_authenticators
     SET last_used_at = CURRENT_TIMESTAMP, failed_attempts = 0
     WHERE user_role = :role AND user_id = :userId`,
    { role, userId },
  );
}

/** A wrong code, and how many have been wrong in a row now. */
async function recordFailure({ role, userId }) {
  await pool.query(
    `UPDATE auth_authenticators
     SET failed_attempts = failed_attempts + 1
     WHERE user_role = :role AND user_id = :userId`,
    { role, userId },
  );
  const row = await find({ role, userId });
  return row ? Number(row.failed_attempts) : 0;
}

/** Switches it off entirely. The row goes; there is nothing worth keeping. */
async function remove({ role, userId }) {
  const [result] = await pool.query(
    `DELETE FROM auth_authenticators
     WHERE user_role = :role AND user_id = :userId`,
    { role, userId },
  );
  return result.affectedRows > 0;
}

module.exports = {
  upsertPending,
  find,
  confirm,
  recordSuccess,
  recordFailure,
  remove,
};
