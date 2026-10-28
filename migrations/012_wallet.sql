-- =====================================================================
-- The driver's wallet: a prepaid float the commission comes out of.
-- =====================================================================
--
-- The owner's model, 26 Oct 2026: a driver tops up between PHP 100 and
-- PHP 3,000 at a time, the passenger settles the fare with the driver
-- directly, and VeteRide's cut is taken OUT of the topped-up balance when a
-- ride completes. So this balance is money paid in, not money earned — the
-- opposite direction from `/drivers/me/earnings`, which reports fares.
--
-- `drivers.wallet_balance` already exists and has always been 0.00 on every
-- row, because nothing ever wrote it. These two tables are what write it.
--
-- WHY A LEDGER AND NOT JUST THE BALANCE. A driver who sees PHP 412 and
-- cannot see what took the other PHP 88 has no way to check our arithmetic
-- against their own, and the first time they disagree they are arguing with
-- a number nobody can explain. Every movement gets a row, and the balance is
-- what the rows add up to.
--
-- driver_id is BIGINT UNSIGNED, matching drivers.driver_id, and the foreign
-- keys are left commented out — both the way every table since 001 does it.
-- The first draft declared INT and a live FK, and MySQL refused the file
-- outright: ERROR 3780, "Referencing column 'driver_id' and referenced
-- column 'driver_id' in foreign key constraint are incompatible".
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/012_wallet.sql

/* ── One attempt to put money in ─────────────────────────────────── */
CREATE TABLE IF NOT EXISTS driver_topups (
  topup_id        CHAR(36)        NOT NULL,
  -- Matches drivers.driver_id exactly. Never a bare "account id": a
  -- customer and a driver may share a number, and a wallet credited to the
  -- wrong table is somebody else's money.
  driver_id       BIGINT UNSIGNED NOT NULL,

  -- Pesos, matching drivers.wallet_balance. PayMongo works in centavos and
  -- converts at its own edge, in one place, rather than every caller
  -- remembering which unit it is holding.
  amount          DECIMAL(10,2)   NOT NULL,

  -- 'gcash' | 'paymaya' | 'grab_pay'
  method          VARCHAR(32)     NOT NULL,

  -- pending    the row exists; the driver has not paid
  -- chargeable they authorised in the wallet app; we are taking the money
  -- paid       money received AND the balance credited
  -- failed     PayMongo refused, or we gave up
  status ENUM('pending','chargeable','paid','failed') NOT NULL DEFAULT 'pending',

  -- The PayMongo source (src_...). The webhook arrives knowing only this,
  -- so it is the key the callback looks the row up by, and it is UNIQUE
  -- because two rows answering to one source is an ambiguity about money.
  source_ref      VARCHAR(255)    NULL,
  -- The payment (pay_...), once the source has actually been charged.
  payment_ref     VARCHAR(255)    NULL,

  checkout_url    TEXT            NULL,
  failure_reason  VARCHAR(500)    NULL,

  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at         DATETIME        NULL,

  PRIMARY KEY (topup_id),
  UNIQUE KEY driver_topups_source_uk (source_ref),
  KEY driver_topups_driver_idx (driver_id, created_at DESC)

  -- , CONSTRAINT driver_topups_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ── Every movement of the float ─────────────────────────────────── */
CREATE TABLE IF NOT EXISTS wallet_ledger (
  entry_id      CHAR(36)        NOT NULL,
  driver_id     BIGINT UNSIGNED NOT NULL,

  kind ENUM('topup','commission','adjustment') NOT NULL,

  -- SIGNED: positive puts money in, negative takes it out. Signed rather
  -- than a magnitude plus a direction, so that SUM(amount) equals the
  -- balance without anybody having to remember which kinds are negative.
  amount        DECIMAL(10,2)   NOT NULL,

  -- The balance AFTER this row, so a statement reads top to bottom without
  -- re-adding every earlier line.
  balance_after DECIMAL(10,2)   NOT NULL,

  trip_id       CHAR(36)        NULL,
  topup_id      CHAR(36)        NULL,
  note          VARCHAR(255)    NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (entry_id),

  -- ONE CREDIT PER TOP-UP, and one debit per trip. These two indexes are
  -- the whole defence against double-counting money, and they are indexes
  -- rather than checks in code because PayMongo retries webhooks and two
  -- deliveries can arrive at once. A credit invented by a network retry is
  -- indistinguishable, afterwards, from a credit somebody paid for.
  --
  -- Both columns are NULL on the rows they do not apply to, and MySQL lets
  -- a unique index hold any number of NULLs — so commission rows do not
  -- collide with each other on topup_id, nor top-ups on trip_id.
  UNIQUE KEY wallet_ledger_topup_uk (topup_id),
  UNIQUE KEY wallet_ledger_trip_commission_uk (trip_id, kind),

  KEY wallet_ledger_driver_idx (driver_id, created_at DESC)

  -- , CONSTRAINT wallet_ledger_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
