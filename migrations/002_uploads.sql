-- =====================================================================
-- Uploads: where a photo lives, and who is allowed to look at it.
-- =====================================================================
--
-- The driver verification endpoint already accepts `license_photo_url` and
-- `or_cr_photo_url` as URL strings, which means the file has to be hosted
-- somewhere before that call is made — and nothing in the repository hosts
-- one. `multer` is in package.json and is not required by any file. This is
-- the missing half.
--
-- What is stored here is the RECORD, not the bytes. The file itself goes to
-- UPLOAD_DIR on disk (or a mounted volume in production); this table is what
-- turns a request for it into an allow or a deny.
--
-- OWNERSHIP IS (id, role), NEVER id ALONE.
--   `customers.user_id`, `drivers.driver_id` and `admins.admin_id` are three
--   separate AUTO_INCREMENT sequences, so customer 1, driver 1 and admin 1
--   are three different people who share a number. An `owner_id = 1` check
--   would hand driver 1 the passenger's licence photo. Every read here
--   matches on both columns together.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/002_uploads.sql

CREATE TABLE IF NOT EXISTS uploads (
  upload_id    CHAR(36)        NOT NULL,

  -- Who it belongs to. Both columns, always, for the reason above.
  owner_id     BIGINT UNSIGNED NOT NULL,
  owner_role   ENUM('rider','driver')  NOT NULL,

  -- What it is for. Kept so the driver's verification form can ask for "the
  -- licence photo" rather than remembering an id, and so an admin reviewing
  -- a driver can see which slot is missing.
  kind         ENUM('license_photo','or_cr_photo','profile_photo')  NOT NULL,

  -- Stored under UPLOAD_DIR. A generated name, never the client's: an
  -- attacker who controls the filename controls the path.
  stored_name  VARCHAR(255)    NOT NULL,
  -- What they called it, for display only. Never used to build a path.
  original_name VARCHAR(255)   NULL,

  mime_type    VARCHAR(100)    NOT NULL,
  size_bytes   INT UNSIGNED    NOT NULL,

  uploaded_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at   DATETIME        NULL,

  PRIMARY KEY (upload_id),

  -- "Everything this person uploaded", which is the only listing there is.
  KEY uploads_owner_idx (owner_role, owner_id, uploaded_at),
  -- "The current licence photo for this driver" — replacing one supersedes
  -- the last rather than accumulating.
  KEY uploads_slot_idx  (owner_role, owner_id, kind, uploaded_at)

  -- Deliberately no foreign key: owner_id points at one of two tables
  -- depending on owner_role, which a single FK cannot express.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
