-- =====================================================================
-- Dispatch: whether a driver is taking work, and how many PINs they missed.
-- =====================================================================
--
-- Adds only new things. Nothing here alters `drivers`, `customers`,
-- `admins` or `verification` — the repository carries no schema file for
-- them, so their real shape in jughstine's deployment is unknown and a
-- migration that guessed at it could break a working database. The two
-- columns added below sit on `trips`, which 001_rides.sql created, so their
-- shape is known exactly.
--
-- Availability is a SEPARATE TABLE rather than a column on `drivers` for
-- that same reason. It reads as a join either way; it deploys as a join
-- that cannot fail.
--
-- Every statement is re-runnable: CREATE TABLE IF NOT EXISTS for the table,
-- and an information_schema check in front of each ALTER, because MySQL 8
-- has no ADD COLUMN IF NOT EXISTS and a second run must not be an error.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/003_dispatch.sql

-- ---------------------------------------------------------------------
-- driver_availability
-- ---------------------------------------------------------------------
-- One row per driver, overwritten. Three states and not a boolean:
-- 'on_trip' belongs to the ride rather than to the switch, so a driver
-- carrying a passenger cannot be shown to dispatch as free, and cannot
-- flip themselves offline mid-ride and vanish from the passenger's map.
--
-- A driver with NO ROW here has never touched the switch, which is
-- 'offline' — the same answer, so nothing has to write a row at signup.
CREATE TABLE IF NOT EXISTS driver_availability (
  driver_id   BIGINT UNSIGNED NOT NULL,
  status      ENUM('offline','online','on_trip') NOT NULL DEFAULT 'offline',
  changed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                       ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (driver_id),
  -- "Who is online now", which is the console's dispatch board and the
  -- only read of this table that is not by primary key.
  KEY driver_availability_status_idx (status, changed_at)

  -- , CONSTRAINT driver_availability_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- trips.pin_attempts, trips.pin_locked_at
-- ---------------------------------------------------------------------
-- The handover PIN is compared server-side, which is only half of a check:
-- four digits fall to ten thousand guesses, and a keypad on a phone can
-- send them faster than anyone can read one out. The count lives on the
-- trip because that is what the limit is per — a fresh ride is a fresh
-- five attempts, and nothing a driver does to one ride can lock another.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'pin_attempts') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN pin_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- When the lock closed, so support can see that it happened and when. The
-- lock itself is read from pin_attempts; this column is the record of it.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'pin_locked_at') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN pin_locked_at DATETIME NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
