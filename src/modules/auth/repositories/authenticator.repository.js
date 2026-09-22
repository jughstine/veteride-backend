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
       locked_until    = NULL,
       last_counter    = NULL,
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
async function confirm({ role, userId, secretSealed, counter }) {
  const [result] = await pool.query(
    `UPDATE auth_authenticators
     SET confirmed_at = CURRENT_TIMESTAMP,
         last_used_at = CURRENT_TIMESTAMP,
         failed_attempts = 0,
         locked_until = NULL,
         -- The confirming code is spent by confirming. Without this it stays
         -- good for the next minute and a half, and the first sign-in could
         -- be walked through with the very digits just typed into the setup
         -- screen.
         last_counter = :counter
     WHERE user_role = :role
       AND user_id = :userId
       AND secret_sealed = :secretSealed
       AND confirmed_at IS NULL`,
    { role, userId, secretSealed, counter },
  );
  return result.affectedRows === 1;
}

/**
 * Spends a code: records the step it belonged to, and clears the wrong-code
 * count.
 *
 * THE UPDATE IS THE CHECK. `last_counter < :counter` is in the WHERE clause,
 * so two requests carrying the same six digits both reach this line and MySQL
 * applies exactly one of them — the second matches no row because the step is
 * no longer newer than what is stored. `affectedRows === 1` is therefore the
 * permission to mint a session, and reading the row first and updating after
 * would hand out two.
 */
async function spendCode({ role, userId, counter }) {
  const [result] = await pool.query(
    `UPDATE auth_authenticators
     SET last_used_at = CURRENT_TIMESTAMP,
         failed_attempts = 0,
         locked_until = NULL,
         last_counter = :counter
     WHERE user_role = :role
       AND user_id = :userId
       AND confirmed_at IS NOT NULL
       AND (last_counter IS NULL OR last_counter < :counter)`,
    { role, userId, counter },
  );
  return result.affectedRows === 1;
}

/**
 * A wrong code. Returns how many are left, and closes the door for a while
 * when they run out.
 *
 * The wait EXPIRES ON ITS OWN, and that is the whole point of `locked_until`.
 * A count with nothing to clear it is not a limit, it is a permanent lock:
 * every route that resets the count is one a locked account can no longer
 * reach, so the fifth typo would end the account for good. The count trips
 * the lock and is then put back to zero; the clock releases it.
 */
async function recordFailure({ role, userId, maxAttempts, lockMinutes }) {
  await pool.query(
    `UPDATE auth_authenticators
     SET failed_attempts = failed_attempts + 1
     WHERE user_role = :role AND user_id = :userId`,
    { role, userId },
  );

  const row = await find({ role, userId });
  const failed = row ? Number(row.failed_attempts) : 0;

  if (failed >= maxAttempts) {
    await pool.query(
      `UPDATE auth_authenticators
       SET locked_until = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL :lockMinutes MINUTE),
           failed_attempts = 0
       WHERE user_role = :role AND user_id = :userId`,
      { role, userId, lockMinutes },
    );
    return 0;
  }
  return Math.max(0, maxAttempts - failed);
}

/**
 * Whether this account is inside a cooling-off period, decided BY THE
 * DATABASE'S clock rather than by node's: the pool is `dateStrings` at +08:00
 * and reading those strings in the process's own timezone could hold a lock
 * open for hours or release it early.
 */
async function lockedFor({ role, userId }) {
  const [rows] = await pool.query(
    `SELECT TIMESTAMPDIFF(SECOND, CURRENT_TIMESTAMP, locked_until) AS seconds_left
     FROM auth_authenticators
     WHERE user_role = :role
       AND user_id = :userId
       AND locked_until IS NOT NULL
       AND locked_until > CURRENT_TIMESTAMP
     LIMIT 1`,
    { role, userId },
  );
  return rows[0] ? Math.max(1, Number(rows[0].seconds_left)) : 0;
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
  spendCode,
  recordFailure,
  lockedFor,
  remove,
};
