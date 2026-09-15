-- =====================================================================
-- The admin console: reviewing a document, and the record of a decision.
-- =====================================================================
--
-- The console reads what the other five migrations already store — trips,
-- payments, vehicles, availability, uploads — and needs exactly two things
-- they do not yet hold:
--
--   * a decision ON ONE UPLOADED DOCUMENT. `uploads` (002) records that a
--     licence photo was received; it does not record that a reviewer looked
--     at it and approved or bounced it. The console's document queue is that
--     review, so the four columns it writes are added to `uploads` here.
--     `uploads` is this repository's own table, so adding to it is safe.
--
--   * a RECORD OF A DRIVER-LEVEL VERIFICATION DECISION. The approve/reject
--     the console performs sets `drivers.verification_status`, which the
--     phone app already reads — but the operator's note, and which admin
--     made the call, have nowhere to go: `drivers` is one of the tables this
--     repository carries no schema for (customers, drivers, admins,
--     verification), whose real shape in jughstine's deployment is unknown,
--     and the existing code reads and writes only `verification_status` on
--     it. So the note and the reviewer are kept in a NEW table of their own
--     rather than in columns on `drivers` that may not exist. The status the
--     app reads stays the single source of truth; this is the audit beside
--     it.
--
-- Account SUSPENSION needs no new storage: the console writes the `status`
-- column that auth.service.js already reads on both `customers` and
-- `drivers` when it decides whether a login may open a session, and that is
-- exactly where a suspension has to live to be enforced. A suspension kept
-- anywhere auth does not read would let a suspended account keep signing in.
--
-- Adds only new things: four columns on `uploads` (created by 002, so its
-- shape is known exactly), one index, and one new table. Nothing here
-- touches `customers`, `drivers`, `admins` or `verification`.
--
-- Re-runnable: an information_schema check in front of every column and
-- index add, since MySQL 8 has no IF NOT EXISTS for either, and
-- CREATE TABLE IF NOT EXISTS for the table.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/006_console.sql

-- ---------------------------------------------------------------------
-- uploads.review_status
-- ---------------------------------------------------------------------
-- Where one document sits in review. DEFAULT 'pending' with NOT NULL, so
-- every document uploaded before this column existed reads as awaiting
-- review — which is the truth: nobody had a way to review them yet, so none
-- of them are approved. The four values match the driver-level ones and the
-- vehicles table's, so one chip renders them all in the console.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'uploads'
      AND COLUMN_NAME = 'review_status') > 0,
  'DO 0',
  'ALTER TABLE uploads ADD COLUMN review_status
     ENUM(''pending'',''approved'',''rejected'',''resubmission_required'')
     NOT NULL DEFAULT ''pending''');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The reviewer's note on that decision, shown back in the console. Kept on
-- the document rather than on the driver because it is about this one file —
-- "the licence is blurred", "the OR/CR is expired" — and a driver may have a
-- different note against each.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'uploads'
      AND COLUMN_NAME = 'review_notes') > 0,
  'DO 0',
  'ALTER TABLE uploads ADD COLUMN review_notes VARCHAR(500) NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Which admin decided it. `admins.admin_id` is a BIGINT UNSIGNED like the
-- other two id sequences; it is stored plain and never joined here, because
-- this repository carries no schema for `admins` and cannot promise the
-- column to a foreign key.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'uploads'
      AND COLUMN_NAME = 'reviewed_by') > 0,
  'DO 0',
  'ALTER TABLE uploads ADD COLUMN reviewed_by BIGINT UNSIGNED NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- When it was decided. NULL for a document nobody has reviewed yet, which
-- together with review_status = 'pending' is how the queue is read: the
-- documents still to look at are the ones with no reviewed_at.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'uploads'
      AND COLUMN_NAME = 'reviewed_at') > 0,
  'DO 0',
  'ALTER TABLE uploads ADD COLUMN reviewed_at DATETIME NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- The review-queue index
-- ---------------------------------------------------------------------
-- "Every driver document still awaiting review", which is the console's
-- documents board and the only read of this table that filters on the
-- review state. owner_role leads because the queue is drivers' documents
-- alone; review_status next because 'pending' is the selective half.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'uploads'
      AND INDEX_NAME = 'uploads_review_idx') > 0,
  'DO 0',
  'CREATE INDEX uploads_review_idx
     ON uploads (owner_role, review_status, uploaded_at)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- driver_verification_reviews
-- ---------------------------------------------------------------------
-- One row per driver-level verification decision the console makes: what was
-- decided, the note behind it, and which admin made the call. This is the
-- audit trail for the approve/reject the operator performs; the decision
-- itself is written to `drivers.verification_status`, which the phone reads,
-- and this table is the history that column cannot hold on its own.
--
-- A history and not a state: many rows per driver, newest last, so a driver
-- bounced for a blurred licence and later approved has both facts on record.
CREATE TABLE IF NOT EXISTS driver_verification_reviews (
  review_id     CHAR(36)        NOT NULL,
  -- Matches drivers.driver_id exactly. Never a bare "account id": customer 1
  -- and driver 1 are different people who share a number.
  driver_id     BIGINT UNSIGNED NOT NULL,

  decision      ENUM('pending','approved','rejected','resubmission_required')
                NOT NULL,
  note          VARCHAR(500)    NULL,

  -- Which admin decided it. Stored plain, for the same reason reviewed_by on
  -- uploads is: this repository carries no schema for `admins`, so no FK.
  reviewed_by   BIGINT UNSIGNED NULL,

  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (review_id),
  -- "This driver's review history", newest first.
  KEY driver_verification_reviews_driver_idx (driver_id, created_at DESC)

  -- , CONSTRAINT dvr_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
