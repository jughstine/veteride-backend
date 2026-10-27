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
-- Run once:  mysql dbveteride < migrations/012_wallet.sql

/* ── One attempt to put money in ─────────────────────────────────── */
CREATE TABLE IF NOT EXISTS driver_topups (
  topup_id        CHAR(36)      NOT NULL PRIMARY KEY,
  driver_id       INT           NOT NULL,

  -- Pesos, matching drivers.wallet_balance. PayMongo works in centavos and
  -- converts at its own edge, in one place, rather than every caller
  -- remembering which unit it is holding.
  amount          DECIMAL(10,2) NOT NULL,

  -- 'gcash' | 'paymaya' | 'grab_pay'
  method          VARCHAR(32)   NOT NULL,

  -- pending    the row exists; the driver has not paid
  -- chargeable they authorised in the wallet app; we are taking the money
  -- paid       money received AND the balance credited
  -- failed     PayMongo refused, or we gave up
  status ENUM('pending','chargeable','paid','failed') NOT NULL DEFAULT 'pending',

  -- The PayMongo source (src_...). The webhook arrives knowing only this,
  -- so it is the key the callback looks the row up by, and it is UNIQUE
  -- because two rows answering to one source is an ambiguity about money.
  source_ref      VARCHAR(255)  NULL UNIQUE,
  -- The payment (pay_...), once the source has actually been charged.
  payment_ref     VARCHAR(255)  NULL,

  checkout_url    TEXT          NULL,
  failure_reason  TEXT          NULL,

  created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at         TIMESTAMP     NULL,

  CONSTRAINT fk_driver_topups_driver
    FOREIGN KEY (driver_id) REFERENCES drivers(driver_id) ON DELETE CASCADE,
  INDEX idx_driver_topups_driver (driver_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

/* ── Every movement of the float ─────────────────────────────────── */
CREATE TABLE IF NOT EXISTS wallet_ledger (
  entry_id      CHAR(36)      NOT NULL PRIMARY KEY,
  driver_id     INT           NOT NULL,

  kind ENUM('topup','commission','adjustment') NOT NULL,

  -- SIGNED: positive puts money in, negative takes it out. Signed rather
  -- than a magnitude plus a direction, so that SUM(amount) equals the
  -- balance without anybody having to remember which kinds are negative.
  amount        DECIMAL(10,2) NOT NULL,

  -- The balance AFTER this row, so a statement reads top to bottom without
  -- re-adding every earlier line.
  balance_after DECIMAL(10,2) NOT NULL,

  trip_id       CHAR(36)      NULL,
  topup_id      CHAR(36)      NULL,
  note          VARCHAR(255)  NULL,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_wallet_ledger_driver
    FOREIGN KEY (driver_id) REFERENCES drivers(driver_id) ON DELETE CASCADE,

  -- ONE CREDIT PER TOP-UP, and one debit per trip. These two indexes are
  -- the whole defence against double-counting money, and they are indexes
  -- rather than checks in code because PayMongo retries webhooks and two
  -- deliveries can arrive at once. A credit invented by a network retry is
  -- indistinguishable, afterwards, from a credit somebody paid for.
  UNIQUE KEY uq_wallet_ledger_topup (topup_id),
  UNIQUE KEY uq_wallet_ledger_trip_commission (trip_id, kind),

  INDEX idx_wallet_ledger_driver (driver_id, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
