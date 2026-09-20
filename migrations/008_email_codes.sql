-- =====================================================================
-- Emailed sign-in codes: the one code an account has pending.
-- =====================================================================
--
-- A rider, driver or admin who asks for a sign-in code gets six digits in
-- their inbox. What the server has to remember between the two requests is
-- only enough to check those digits once, and to stop somebody guessing
-- them: the HASH of the code, when it stops working, how many wrong
-- guesses it has taken, and whether it has already been spent.
--
-- ONE ROW PER ACCOUNT, and that is the point of the key. The primary key is
-- (user_role, user_id), so asking for a second code OVERWRITES the first
-- rather than adding to it — the older code stops working the moment a new
-- one is sent, which is what a person expects when they tap "send it
-- again", and it means a mailbox full of old codes is a mailbox full of
-- dead ones. A table keyed by the code instead would leave every code ever
-- issued live until it timed out.
--
-- THE ROLE IS PART OF THE KEY, not decoration. customers.user_id,
-- drivers.driver_id and admins.admin_id are three separate sequences:
-- customer 1 and driver 1 are different people who share a number. A row
-- keyed on the id alone would let a code mailed to driver 1 open customer
-- 1's account.
--
-- ONLY THE HASH IS STORED. The digits exist in the e-mail and nowhere else
-- — not in this table, not in a log, not in any response body. The hash is
-- an HMAC (see src/utils/email-code.js) rather than a bare digest, because
-- a plain SHA-256 of six digits is a million-entry rainbow table anybody
-- who reads this table could build in a second.
--
-- Adds only a new table. Nothing here alters `customers`, `drivers`,
-- `admins`, `verification`, `auth_refresh_tokens` or
-- `auth_password_reset_tokens` — this repository carries no schema for
-- those, so their real shape in jughstine's deployment is unknown and a
-- migration that guessed at it could break a live database.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS, plus the same information_schema
-- guard 003-006 use in front of the index add, since MySQL 8 has no CREATE
-- INDEX IF NOT EXISTS. Running this file twice is a no-op the second time.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/008_email_codes.sql

-- ---------------------------------------------------------------------
-- auth_email_codes
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_email_codes (
  -- Which sign-in table the id belongs to. Same three names the JWT and
  -- auth_refresh_tokens.user_role already carry.
  user_role     ENUM('rider','driver','admin') NOT NULL,
  -- Matches customers.user_id / drivers.driver_id / admins.admin_id.
  user_id       BIGINT UNSIGNED NOT NULL,

  -- HMAC-SHA256, hex. 64 characters, fixed width, so the comparison the
  -- server makes is over two equal-length buffers and can be timing-safe.
  code_hash     CHAR(64)        NOT NULL,

  -- When the digits stop working. Written once, when the code is minted,
  -- and NEVER touched again: a wrong guess must not buy more time, and a
  -- right one must not be accepted a second later than a wrong one would
  -- have been.
  expires_at    DATETIME        NOT NULL,

  -- Wrong guesses so far. Six digits is a million, which is a lot for a
  -- person and nothing for a script, so the window is closed by this count
  -- long before it is closed by the clock. Reset to 0 when a new code
  -- replaces this row.
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,

  -- When the code was spent. One use only: a code that opened a session is
  -- finished, so a captured reply cannot be replayed into a second one.
  consumed_at   DATETIME        NULL,

  -- Who asked, for the support question "somebody keeps mailing me codes".
  -- The address only; nothing about the code itself.
  requested_ip  VARCHAR(45)     NULL,

  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,

  -- The replace-not-append key. Every read is by this exact pair.
  PRIMARY KEY (user_role, user_id),

  -- For sweeping dead rows: DELETE FROM auth_email_codes WHERE expires_at
  -- < NOW() - INTERVAL 1 DAY. Nothing in the running code depends on the
  -- sweep — an expired row is already refused by the expires_at check on
  -- every read, and is overwritten the next time that account asks — so
  -- this is housekeeping the owner can run when they like, not a job.
  KEY auth_email_codes_expiry_idx (expires_at)

  -- No foreign key: see the note at the top. The three parent tables are
  -- not this repository's to promise.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The expiry index again, for a database where this table already existed
-- without it. CREATE TABLE IF NOT EXISTS above is a no-op on a second run
-- and would not add a key to a table it did not create.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'auth_email_codes'
      AND INDEX_NAME = 'auth_email_codes_expiry_idx') > 0,
  'DO 0',
  'CREATE INDEX auth_email_codes_expiry_idx ON auth_email_codes (expires_at)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
