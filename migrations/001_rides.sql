-- =====================================================================
-- Rides: trips, driver positions, and the ride thread.
-- =====================================================================
--
-- Adds only new tables. Nothing here alters `customers`, `drivers`,
-- `admins`, `auth_refresh_tokens`, `auth_password_reset_tokens` or
-- `verification` — the repository carries no schema file, so the shape of
-- those is known only from the SQL embedded in src/, and a migration that
-- guessed at them could break a working deployment.
--
-- The two names this file does depend on are stated outright in
-- src/modules/auth/repositories/role-tables.js:
--
--     rider  -> table "customers", idColumn "user_id"
--     driver -> table "drivers",   idColumn "driver_id"
--
-- Both are BIGINT UNSIGNED AUTO_INCREMENT, and they are per-table: customer
-- 1 and driver 1 are DIFFERENT PEOPLE. Nothing here may ever ask "is this
-- account a party to this ride" without also knowing which role it is
-- asking about — `user_id = :id OR driver_id = :id` would hand a driver the
-- passenger's ride whenever their two ids happened to match. Every query in
-- trip.repository.js takes the role for exactly this reason.
--
-- The foreign keys are left commented out until the parent tables are
-- confirmed against jughstine's real schema rather than the reconstructed
-- one; the queries scope by role regardless, so these are a safety net.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/001_rides.sql

-- ---------------------------------------------------------------------
-- trips
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trips (
  trip_id            CHAR(36)         NOT NULL,
  -- Matches customers.user_id and drivers.driver_id exactly.
  user_id            BIGINT UNSIGNED  NOT NULL,
  driver_id          BIGINT UNSIGNED  NULL,

  -- The lifecycle, in order. A ride only ever moves forwards through
  -- these, except to 'cancelled', which any live state may reach.
  status             ENUM('requested','matched','en_route_pickup',
                          'in_progress','completed','cancelled')
                     NOT NULL DEFAULT 'requested',

  pickup_address     VARCHAR(255)  NOT NULL,
  pickup_lat         DECIMAL(9,6)  NOT NULL,
  pickup_lng         DECIMAL(9,6)  NOT NULL,
  dropoff_address    VARCHAR(255)  NOT NULL,
  dropoff_lat        DECIMAL(9,6)  NOT NULL,
  dropoff_lng        DECIMAL(9,6)  NOT NULL,

  distance_km        DECIMAL(6,2)  NULL,
  estimated_minutes  INT           NULL,
  estimated_fare     DECIMAL(10,2) NULL,
  final_fare         DECIMAL(10,2) NULL,

  -- Minted by the server, never by a handset: a PIN a phone generates is a
  -- number only that phone knows, which is not a handover.
  pin                CHAR(4)       NULL,

  cancelled_by       ENUM('rider','driver','system') NULL,
  cancel_reason      VARCHAR(255)  NULL,

  requested_at       DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  matched_at         DATETIME      NULL,
  pickup_at          DATETIME      NULL,
  dropoff_at         DATETIME      NULL,
  updated_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
                                   ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (trip_id),

  -- "What is this passenger's current ride?" and "what has this driver
  -- done?" are the only two reads that are not by primary key.
  KEY trips_user_idx   (user_id, requested_at DESC),
  KEY trips_driver_idx (driver_id, requested_at DESC),

  -- Dispatch reads unclaimed rides inside a bounding box. Status leads
  -- because it is the most selective: almost every row is 'completed'.
  KEY trips_open_idx   (status, pickup_lat, pickup_lng),

  CONSTRAINT trips_pin_four_digits
    CHECK (pin IS NULL OR pin REGEXP '^[0-9]{4}$'),
  -- A cancellation nobody can attribute is a row nobody can explain.
  CONSTRAINT trips_cancelled_by_present
    CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL))

  -- , CONSTRAINT trips_user_fk   FOREIGN KEY (user_id)   REFERENCES customers(user_id)
  -- , CONSTRAINT trips_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- driver_positions
-- ---------------------------------------------------------------------
-- One row per driver, overwritten. A history of every fix a phone ever
-- posted is a different feature with different storage costs; what
-- dispatch needs is "where is this driver now".
CREATE TABLE IF NOT EXISTS driver_positions (
  driver_id   BIGINT UNSIGNED NOT NULL,
  lat         DECIMAL(9,6) NOT NULL,
  lng         DECIMAL(9,6) NOT NULL,
  heading     DECIMAL(5,2) NULL,
  accuracy_m  DECIMAL(7,2) NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (driver_id),
  -- Dispatch scans by box; a stale fix is worse than none, so the sweep
  -- filters on updated_at too.
  KEY driver_positions_box_idx (lat, lng, updated_at)

  -- , CONSTRAINT driver_positions_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- trip_messages
-- ---------------------------------------------------------------------
-- Scoped to a trip on purpose. There is no conversation between two
-- accounts in general — a passenger may message the driver carrying them
-- and nobody else, and the ride is what grants that right.
CREATE TABLE IF NOT EXISTS trip_messages (
  message_id   CHAR(36)                  NOT NULL,
  trip_id      CHAR(36)                  NOT NULL,
  sender_id    BIGINT UNSIGNED           NOT NULL,
  sender_role  ENUM('rider','driver')    NOT NULL,
  body         VARCHAR(2000)             NOT NULL,
  sent_at      DATETIME                  NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (message_id),
  KEY trip_messages_thread_idx (trip_id, sent_at),

  CONSTRAINT trip_messages_body_present CHECK (CHAR_LENGTH(TRIM(body)) > 0),
  CONSTRAINT trip_messages_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
