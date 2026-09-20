-- =====================================================================
-- A driver passing on a booking, so dispatch can move it to the others.
-- =====================================================================
--
-- The rule this exists for is the owner's (17 Sep 2026): "if the driver did
-- not accept the request for 30 seconds the passenger will keep looking for
-- other available drivers."
--
-- Until now a pass was told to nobody. A request stays `requested` and is
-- handed to every nearby driver of the right vehicle class on every poll, so
-- the driver who let their card lapse — or tapped Decline — was offered the
-- same booking again two seconds later, for as long as they sat on the
-- dashboard, while the passenger's wait looked identical whether one driver
-- had refused it or ten had never seen it.
--
-- What is recorded here is ONLY that pass. Nothing in this file touches
-- `trips.status`: a decline is not a cancellation, the row stays open, and
-- the existing TTL sweeper is still the only thing that ends a request
-- nobody took. That separation is the whole safety of the feature — a
-- decline that could cancel a ride would let any one driver in the city end
-- a stranger's booking.
--
-- Adds only a new table. Nothing here alters `trips` (001), `customers`,
-- `drivers`, `admins` or `verification` — this repository carries no schema
-- for the last four, so their real shape in jughstine's deployment is
-- unknown and a migration that guessed at it could break a live database.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS, and an information_schema check
-- in front of the index add, since MySQL 8 has no CREATE INDEX IF NOT
-- EXISTS. Running this file twice is a no-op the second time.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/007_declines.sql

-- ---------------------------------------------------------------------
-- trip_declines
-- ---------------------------------------------------------------------
-- One row per (booking, driver who passed on it). The primary key IS the
-- idempotency: a driver who declines twice — a double tap, a retry over a
-- flaky tunnel, a lapse arriving just after the tap — writes the same key
-- twice and the second write updates the timestamp instead of erroring.
--
-- `declined_at` is what the cool-off is measured from, and it is refreshed
-- by that second write on purpose: the window belongs to the last time this
-- driver said no, not to the first. A driver who is offered a booking again
-- after their window lapses and passes on it again has told dispatch the
-- same thing twice, and gets the same quiet for it.
--
-- A pass EXPIRES. It is not a blacklist: after
-- `RIDES.DECLINE_COOLOFF_MIN` (default 3 minutes) the booking becomes
-- visible to this driver again, so a ride every driver in range has passed
-- on comes back to them rather than dying silently — and a ride nobody ever
-- takes still ends the way it always did, at the request TTL, cancelled by
-- 'system' with a reason the passenger's app can read. The cool-off must
-- stay well under REQUEST_TTL_MIN for that to be true.
--
-- Rows are kept, not swept. One booking collects at most one row per driver
-- who saw it, `trips` itself is never pruned either, and a delete pass would
-- be a second scheduled job in a process that deliberately has none. The
-- reads are all by primary key prefix or by driver, and both are indexed.
CREATE TABLE IF NOT EXISTS trip_declines (
  trip_id      CHAR(36)         NOT NULL,
  -- Matches drivers.driver_id exactly, as trips.driver_id does.
  driver_id    BIGINT UNSIGNED  NOT NULL,
  declined_at  DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- (trip_id, driver_id) and in that order, because the read dispatch makes
  -- is "has THIS DRIVER passed on this row" inside a NOT EXISTS correlated
  -- on trip_id — the leading column of the key is the one the subquery
  -- already has in hand.
  PRIMARY KEY (trip_id, driver_id),

  -- The other direction: "what has this driver passed on lately", which is
  -- how a support question about a driver who sees nothing gets answered.
  KEY trip_declines_driver_idx (driver_id, declined_at),

  CONSTRAINT trip_declines_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE

  -- , CONSTRAINT trip_declines_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The driver-side index again, for a database where this table already
-- existed without it. CREATE TABLE IF NOT EXISTS above is a no-op on a
-- second run and would not add a key to a table it did not create, so the
-- index is asserted separately — the same information_schema guard 003-006
-- use in front of every ALTER.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trip_declines'
      AND INDEX_NAME = 'trip_declines_driver_idx') > 0,
  'DO 0',
  'CREATE INDEX trip_declines_driver_idx ON trip_declines (driver_id, declined_at)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
