-- =====================================================================
-- Google Authenticator: the one TOTP secret an account may hold.
-- =====================================================================
--
-- An optional second step, switched on by the person and not by us. Nothing
-- in this file changes what happens to an account that never enrols: no row,
-- no challenge, sign-in exactly as it is today.
--
-- ONE ROW PER ACCOUNT, keyed (user_role, user_id) for the same two reasons
-- auth_email_codes is: enrolling again REPLACES the previous secret rather
-- than leaving two live ones, and customer 1, driver 1 and admin 1 are three
-- different people who happen to share a number.
--
-- THE SECRET IS ENCRYPTED, not hashed. A password can be hashed because the
-- server only ever has to say yes or no to one that is offered; a TOTP secret
-- has to be read back to compute the code, so it has to be reversible to this
-- server and to nobody else. It is sealed with AES-256-GCM under a key
-- derived from the signing secret (src/utils/totp.js), so a copy of this
-- table on its own — a backup, a dump, a compromised read-only account —
-- yields nothing that generates a code.
--
-- CONFIRMED IS THE SWITCH. A row appears the moment somebody asks to enrol,
-- and `confirmed_at` stays NULL until they have proved the secret reached
-- their phone by typing six digits from it. Only a confirmed row challenges a
-- sign-in. Without that split, an enrolment abandoned half-way — the QR
-- scanned but never confirmed, the app deleted, the phone lost — would lock
-- the account out of itself forever.
--
-- Adds only a new table. Nothing here alters `customers`, `drivers`,
-- `admins`, `auth_refresh_tokens` or `auth_email_codes` — this repository
-- carries no schema for the account tables, so their real shape in
-- production is unknown and a migration that guessed could break a live
-- database.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS plus the information_schema guard
-- 003-008 use in front of the index add. Running it twice is a no-op.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/009_authenticator.sql

-- ---------------------------------------------------------------------
-- auth_authenticators
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth_authenticators (
  -- Same three names the JWT, auth_refresh_tokens and auth_email_codes use.
  user_role      ENUM('rider','driver','admin') NOT NULL,
  -- Matches customers.user_id / drivers.driver_id / admins.admin_id.
  user_id        BIGINT UNSIGNED NOT NULL,

  -- The sealed secret: iv:tag:ciphertext, hex, AES-256-GCM. Never the base32
  -- the phone was shown, and never anything a code can be computed from
  -- without this server's signing secret.
  secret_sealed  VARCHAR(512)    NOT NULL,

  -- NULL while an enrolment is only half done. Set when six digits from the
  -- phone proved the secret arrived, and that is the moment this account
  -- starts being challenged at sign-in.
  confirmed_at   DATETIME        NULL,

  -- When a code from this authenticator was last accepted. Support answers
  -- "is it still working" out of this, and nothing depends on it.
  last_used_at   DATETIME        NULL,

  -- Wrong codes since the last accepted one, reset on success. Six digits is
  -- a million, which is a wall for a person and a few minutes for a script
  -- against a 90-second window, so the count is what actually closes it.
  failed_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,

  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                 ON UPDATE CURRENT_TIMESTAMP,

  -- The replace-not-append key. Every read is by this exact pair.
  PRIMARY KEY (user_role, user_id),

  -- For "how many people actually turned this on", which is the only
  -- question anybody asks of this table in bulk.
  KEY auth_authenticators_confirmed_idx (confirmed_at)

  -- No foreign key: see the note at the top. The three parent tables are not
  -- this repository's to promise.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The index again, for a database where this table already existed without
-- it. CREATE TABLE IF NOT EXISTS above is a no-op on a second run and would
-- not add a key to a table it did not create.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'auth_authenticators'
      AND INDEX_NAME = 'auth_authenticators_confirmed_idx') > 0,
  'DO 0',
  'CREATE INDEX auth_authenticators_confirmed_idx ON auth_authenticators (confirmed_at)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
