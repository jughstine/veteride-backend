-- =====================================================================
-- Vehicles, and the class a ride is booked for.
-- =====================================================================
--
-- "If they book for example in motorcycle only driver with motorcycle will
-- see; in 4 wheels it's 4 wheels" — the owner's request, 15 Sep 2026. A
-- booking therefore names the vehicle it needs, and dispatch offers it only
-- to drivers on that kind of vehicle. None of this existed anywhere: not in
-- this API, not in the app, not in the reference backend.
--
-- THE THREE NAMES ARE THE CONTRACT: 'motorcycle', 'car', 'truck6', and the
-- two services 'ride' and 'parcel'. The PostgreSQL side of the house
-- (veterideapp/admin) spells them identically on purpose; a fourth spelling
-- anywhere is a ride nobody is offered.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS, and an information_schema check
-- in front of every ALTER, since MySQL 8 has no IF NOT EXISTS for columns,
-- constraints or indexes.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/004_vehicles.sql

-- ---------------------------------------------------------------------
-- vehicles
-- ---------------------------------------------------------------------
-- What a driver drives. A driver may own several — a rider's motorcycle
-- and the family car — so this is a table and not three columns on
-- `drivers`, which this migration is not allowed to touch anyway.
--
-- vehicle_class is stored ALREADY NORMALISED, next to the free-text
-- vehicle_type the console operator actually typed. Dispatch filters on
-- the class, and a WHERE that had to normalise 'suv' into 'car' row by row
-- could use no index at all.
CREATE TABLE IF NOT EXISTS vehicles (
  vehicle_id      CHAR(36)        NOT NULL,
  -- Matches drivers.driver_id exactly. Never a bare "account id": customer
  -- 1 and driver 1 are different people who share a number.
  driver_id       BIGINT UNSIGNED NOT NULL,

  plate_number    VARCHAR(20)     NOT NULL,
  vehicle_model   VARCHAR(100)    NULL,
  -- What was typed. Kept because it is what the operator and the driver
  -- recognise, and because it is the input the class was derived from.
  vehicle_type    VARCHAR(40)     NULL,
  -- What dispatch reads. NULL means "this vehicle cannot be classified",
  -- which is a real answer: such a driver is offered nothing and is told
  -- why, rather than being quietly offered every motorcycle booking.
  vehicle_class   ENUM('motorcycle','car','truck6') NULL,
  vehicle_color   VARCHAR(40)     NULL,

  verification_status ENUM('pending','approved','rejected','resubmission_required')
                      NOT NULL DEFAULT 'pending',

  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                  ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (vehicle_id),
  -- A plate is one vehicle. Two rows claiming it is either a typo or two
  -- drivers about to be offered each other's work.
  UNIQUE KEY vehicles_plate_uk (plate_number),
  -- "What does this driver drive", which dispatch asks on every open list.
  KEY vehicles_driver_idx (driver_id, created_at DESC),
  KEY vehicles_class_idx  (vehicle_class, verification_status)

  -- , CONSTRAINT vehicles_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- trips.vehicle_class, trips.service
-- ---------------------------------------------------------------------
-- Both NOT NULL with a default, so the rows booked before this file ran
-- stay valid and mean what they meant: every one of them was a motorcycle
-- ride, because that was the only thing the app could book.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'vehicle_class') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN vehicle_class VARCHAR(16) NOT NULL DEFAULT ''motorcycle''');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 'ride' or 'parcel'. The app has sent a `service` on every booking since
-- the first build and this API dropped it on the floor for want of a
-- column; a parcel and a passenger are not the same job and the driver's
-- card has to say which one they are being offered.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'service') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN service VARCHAR(16) NOT NULL DEFAULT ''ride''');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The vehicle the winning driver was on. Recorded at the moment of the
-- accept rather than looked up later: a driver may sell the motorcycle, and
-- last week's receipt still has to say what carried that passenger.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'vehicle_id') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN vehicle_id CHAR(36) NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- How long it actually took, stamped once at dropoff. The estimate is what
-- the passenger agreed to; this is what happened, and a receipt that can
-- only quote the estimate cannot be checked against anything.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'actual_duration_min') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN actual_duration_min INT NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- The two CHECK constraints
-- ---------------------------------------------------------------------
-- The columns are VARCHAR rather than ENUM so that adding a fourth class
-- later is a constraint change and not a table rebuild; the CHECK is what
-- keeps them to the contract in the meantime.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND CONSTRAINT_NAME = 'trips_vehicle_class_valid') > 0,
  'DO 0',
  'ALTER TABLE trips ADD CONSTRAINT trips_vehicle_class_valid
     CHECK (vehicle_class IN (''motorcycle'',''car'',''truck6''))');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND CONSTRAINT_NAME = 'trips_service_valid') > 0,
  'DO 0',
  'ALTER TABLE trips ADD CONSTRAINT trips_service_valid
     CHECK (service IN (''ride'',''parcel''))');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- The dispatch index
-- ---------------------------------------------------------------------
-- Class leads after status because it is now the most selective predicate
-- there is: a motorcycle rider is shown none of the car bookings at all,
-- and the box comparison should run over what is left rather than over
-- every open request in the city. trips_open_idx from 001 stays — it still
-- serves the console's unfiltered board.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND INDEX_NAME = 'trips_open_class_idx') > 0,
  'DO 0',
  'CREATE INDEX trips_open_class_idx
     ON trips (status, vehicle_class, pickup_lat, pickup_lng)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
