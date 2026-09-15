-- =====================================================================
-- The end of a ride: what it cost, how it was settled, and what the
-- passenger thought of it.
-- =====================================================================
--
-- Three things this API had nowhere to put:
--
--   * the way the passenger chose to pay. The app has offered six of them
--     since its first build — GCash, QR Ph, e-wallet, UnionBank online,
--     InstaPay and cash — and every one of them ended at a column that did
--     not exist, so every ride was settled by a method nobody recorded.
--
--   * the money of a finished ride, as a record somebody can be shown.
--     `trips.final_fare` is the fare; a receipt is the fare, what the
--     platform kept, what the driver earned and how the two of them
--     settled it.
--
--   * the rating and the tip. The passenger's screen has collected both
--     since the first build and thrown both away at the moment they tapped
--     Done, which is the one moment they meant them.
--
-- Adds only new things: five columns on `trips` (created by 001, so its
-- shape is known exactly) and one new table. Nothing here touches
-- `customers`, `drivers`, `admins` or `verification` — this repository
-- carries no schema for them.
--
-- Re-runnable: CREATE TABLE IF NOT EXISTS, and an information_schema check
-- in front of every ALTER, since MySQL 8 has no IF NOT EXISTS for columns,
-- constraints or indexes.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/005_fares.sql

-- ---------------------------------------------------------------------
-- trips.payment_method
-- ---------------------------------------------------------------------
-- What the passenger chose on the booking screen, carried by the ride to
-- its own end. NOT NULL with a default because the rides booked before
-- this column existed were all settled the same way: the passenger handed
-- the driver money.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'payment_method') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN payment_method VARCHAR(20) NOT NULL DEFAULT ''cash''');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- trips.rating, trips.rating_comment, trips.tip_amount, trips.rated_at
-- ---------------------------------------------------------------------
-- On the trip rather than in a table of their own, because a rating is not
-- an opinion about a driver in general: it is what one passenger thought
-- of one ride, and the ride is the only thing that grants the right to
-- leave it. One row per trip is then the primary key doing the work, and
-- "sent once" is a WHERE clause on rated_at rather than a read followed by
-- a write that two taps can both pass.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'rating') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN rating TINYINT UNSIGNED NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'rating_comment') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN rating_comment VARCHAR(500) NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- NULL and 0 are different answers here. NULL is "this ride has not been
-- rated"; 0 is "it was rated and no tip was left", which is a thing the
-- passenger decided and the driver's dashboard should not confuse with
-- silence.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'tip_amount') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN tip_amount DECIMAL(10,2) NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- The stamp is what makes the rating once-only: the conditional UPDATE
-- that writes a rating requires this to be NULL, so the second tap changes
-- no rows and is told so, whichever order two of them arrive in.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND COLUMN_NAME = 'rated_at') > 0,
  'DO 0',
  'ALTER TABLE trips ADD COLUMN rated_at DATETIME NULL');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- The constraints on those columns
-- ---------------------------------------------------------------------
-- The six ways the app offers, plus the two words the PR's own
-- /me/preferences already stores ('card', and 'maya' which normalises to
-- an e-wallet before it reaches here). VARCHAR with a CHECK rather than an
-- ENUM, for the same reason vehicle_class is: a seventh way to pay is then
-- a constraint change and not a table rebuild.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND CONSTRAINT_NAME = 'trips_payment_method_valid') > 0,
  'DO 0',
  'ALTER TABLE trips ADD CONSTRAINT trips_payment_method_valid
     CHECK (payment_method IN (''cash'',''gcash'',''qrph'',''ewallet'',
                               ''unionbank'',''instapay'',''card''))');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- One to five stars. The screen cannot send anything else; this stops a
-- second writer, later, storing a nine.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND CONSTRAINT_NAME = 'trips_rating_in_range') > 0,
  'DO 0',
  'ALTER TABLE trips ADD CONSTRAINT trips_rating_in_range
     CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- An equivalence, like trips_cancelled_by_present: a rating and the moment
-- it was left are one act, and a row carrying one without the other is a
-- rating that can be sent again or a lock nobody can explain.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND CONSTRAINT_NAME = 'trips_rated_at_present') > 0,
  'DO 0',
  'ALTER TABLE trips ADD CONSTRAINT trips_rated_at_present
     CHECK ((rating IS NULL) = (rated_at IS NULL))');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- A tip is money given. Negative money is money taken.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND CONSTRAINT_NAME = 'trips_tip_non_negative') > 0,
  'DO 0',
  'ALTER TABLE trips ADD CONSTRAINT trips_tip_non_negative
     CHECK (tip_amount IS NULL OR tip_amount >= 0)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- The rating index
-- ---------------------------------------------------------------------
-- "What is this driver's rating" is an average over their own rated rides,
-- read on every trip view the passenger's app polls. Both columns are in
-- the index, so it is answered without touching the table.
SET @stmt := IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'trips'
      AND INDEX_NAME = 'trips_driver_rating_idx') > 0,
  'DO 0',
  'CREATE INDEX trips_driver_rating_idx ON trips (driver_id, rating)');
PREPARE stmt FROM @stmt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------
-- One row per finished ride: what was charged, how, and to whom it went.
--
-- A separate table from `trips` because it is a different thing with a
-- different life. A trip is over at the drop-off; a payment can be
-- refunded next week, and the console's payments board and its refund
-- button read and write exactly these columns.
--
-- THE GATEWAY REFERENCE IS THE POINT OF settled_with. Nothing in this API
-- can charge a card or draw on an e-wallet — there is no payment
-- integration here at all — so whatever the passenger chose on the booking
-- screen, the money changes hands between the two people at the drop-off.
-- A row that says 'driver' is that: the fare was settled with the driver,
-- and no gateway confirmed anything. The CHECK at the bottom is what stops
-- a later writer claiming otherwise without a reference to show for it.
CREATE TABLE IF NOT EXISTS payments (
  payment_id          CHAR(36)        NOT NULL,
  -- NULL is allowed for a payment that is not a ride's — a wallet top-up,
  -- say — and UNIQUE so one ride can never grow two receipts. MySQL
  -- permits many NULLs under a UNIQUE key, so both hold at once.
  trip_id             CHAR(36)        NULL,
  -- Matches customers.user_id. Never a bare "account id": customer 1 and
  -- driver 1 are different people who share a number. The driver is read
  -- through the trip, which is the only thing that knows who drove it.
  rider_id            BIGINT UNSIGNED NOT NULL,

  amount              DECIMAL(10,2)   NOT NULL,
  payment_method      VARCHAR(20)     NOT NULL,
  status              ENUM('pending','completed','failed','refunded')
                      NOT NULL DEFAULT 'pending',
  -- Who actually took the money: the driver, in person, or a gateway.
  settled_with        ENUM('driver','gateway') NOT NULL DEFAULT 'driver',

  -- What the platform kept and what the driver earned. Both NULL rather
  -- than 0 where they have not been worked out, because zero commission is
  -- a rate somebody chose and this API's default rate is exactly that.
  platform_fee        DECIMAL(10,2)   NULL,
  driver_earnings     DECIMAL(10,2)   NULL,
  tip_amount          DECIMAL(10,2)   NULL,
  discount_amount     DECIMAL(10,2)   NULL,
  refund_amount       DECIMAL(10,2)   NULL,
  refund_reason       VARCHAR(255)    NULL,
  -- The gateway's own id for the charge. NULL for every row this build
  -- writes, and that is the honest value.
  payment_gateway_ref VARCHAR(100)    NULL,

  paid_at             DATETIME        NULL,
  created_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                      ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (payment_id),
  UNIQUE KEY payments_trip_uk (trip_id),
  -- The console's board is newest first; its filter is by status.
  KEY payments_created_idx (created_at DESC),
  KEY payments_status_idx  (status, created_at),
  -- "What have I paid for" — the passenger's own receipts.
  KEY payments_rider_idx   (rider_id, created_at DESC),

  CONSTRAINT payments_amounts_non_negative CHECK (
    amount >= 0
      AND (platform_fee    IS NULL OR platform_fee    >= 0)
      AND (driver_earnings IS NULL OR driver_earnings >= 0)
      AND (tip_amount      IS NULL OR tip_amount      >= 0)
      AND (discount_amount IS NULL OR discount_amount >= 0)
      AND (refund_amount   IS NULL OR refund_amount   >= 0)
  ),
  -- Refunding more than was charged is not a refund.
  CONSTRAINT payments_refund_within_amount CHECK (
    refund_amount IS NULL OR refund_amount <= amount
  ),
  -- A completed gateway payment has the gateway's reference on it. Without
  -- this, "completed" is a claim anybody can write; with it, the claim has
  -- to carry the evidence for itself.
  CONSTRAINT payments_gateway_ref_present CHECK (
    settled_with = 'driver'
      OR status <> 'completed'
      OR payment_gateway_ref IS NOT NULL
  ),

  CONSTRAINT payments_trip_fk
    FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE RESTRICT

  -- , CONSTRAINT payments_rider_fk FOREIGN KEY (rider_id) REFERENCES customers(user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
