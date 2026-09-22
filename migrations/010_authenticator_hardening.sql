-- =====================================================================
-- Authenticator: a lock that lets go, and a code that is spent once.
-- =====================================================================
--
-- Two columns on auth_authenticators, and nothing else. Separate from 009
-- because 009 has been merged and may already have been run: a migration
-- that has been applied somewhere is finished, and changing it afterwards
-- means one database silently disagreeing with another.
--
-- ---------------------------------------------------------------------
-- locked_until — why a count alone was a permanent lock
-- ---------------------------------------------------------------------
-- As 009 shipped it, `failed_attempts` was compared against the limit and
-- nothing could ever clear it. Every route that resets the count is one the
-- account can no longer reach once it is full: the refusal happens BEFORE
-- the code is looked at, so no correct code clears it; re-enrolling is
-- refused while an authenticator is confirmed; and switching it off needs a
-- code, which is refused for the same reason. The fifth mistyped code ended
-- the account, and the refusal that told the person to "wait a few minutes"
-- was not true — there was nothing to wait for.
--
-- Now the count trips a lock and is put back to zero, and the CLOCK releases
-- it. Fifteen minutes by default (AUTHENTICATOR_LOCK_MIN).
--
-- ---------------------------------------------------------------------
-- last_counter — why "the right code" was not enough
-- ---------------------------------------------------------------------
-- A TOTP code is good for its own 30-second step and the one either side,
-- which is ninety seconds of the same six digits. Inside that window the
-- same code could be presented twice: read over a shoulder, photographed,
-- or lifted out of a captured request, and then spent again for a second
-- session. RFC 6238 §5.2 says a verifier SHOULD refuse that.
--
-- This column remembers the step a code was last accepted for, and the
-- update that records it is the check — `last_counter < :counter` lives in
-- the WHERE clause, so two requests carrying the same digits both arrive and
-- MySQL applies exactly one.
--
-- Additive and re-runnable: each column is added only if it is not already
-- there, with the same information_schema guard 003-009 use. Running this
-- file twice is a no-op, and it alters nothing but the table 009 created.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/010_authenticator_hardening.sql

-- ---------------------------------------------------------------------
-- locked_until
-- ---------------------------------------------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'auth_authenticators'
      AND COLUMN_NAME = 'locked_until') > 0,
  'DO 0',
  'ALTER TABLE auth_authenticators ADD COLUMN locked_until DATETIME NULL AFTER failed_attempts');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- last_counter
-- ---------------------------------------------------------------------
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'auth_authenticators'
      AND COLUMN_NAME = 'last_counter') > 0,
  'DO 0',
  'ALTER TABLE auth_authenticators ADD COLUMN last_counter BIGINT UNSIGNED NULL AFTER locked_until');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Anybody already enrolled keeps working: both columns are NULL, which means
-- "not locked" and "no code spent yet", and the first code they use records
-- itself from then on.
