-- =====================================================================
-- 014_payouts.sql — taking money back out. The mirror of driver_topups.
-- =====================================================================
--
-- The driver asks, the wallet is debited there and then, and the money is
-- sent afterwards. See docs/cash-out.md for the routes and the rules the
-- app on the other side already depends on.
--
-- Owner's figures, 4 Nov 2026: PHP 500 minimum, PHP 3,000 maximum, PHP 10
-- fee borne by the DRIVER. Serve all three from GET /drivers/me/wallet as
-- min_payout, max_payout and payout_fee — the app reads them, so changing
-- any of them later is a server change with no app release.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/014_payouts.sql
--
-- NOT fully re-runnable: the MODIFY below is idempotent in effect, but
-- ADD COLUMN is not — MySQL has no IF NOT EXISTS for it. Running this
-- twice fails on the second ALTER with "Duplicate column name", which is
-- noisy rather than harmful.

/* ── One attempt to pay money out ─────────────────────────────────── */
CREATE TABLE IF NOT EXISTS driver_payouts (
  payout_id       CHAR(36)        NOT NULL,

  -- Matches drivers.driver_id exactly, the way every table since 001 does.
  -- The first draft of 012 declared INT against a BIGINT UNSIGNED and MySQL
  -- refused the file outright (ERROR 3780).
  driver_id       BIGINT UNSIGNED NOT NULL,

  -- Pesos, matching drivers.wallet_balance.
  --
  -- amount     leaves the wallet
  -- fee        what VeteRide keeps for the transfer
  -- net_amount what actually lands, STORED rather than computed on read:
  --            the fee may change, and a statement from March must still
  --            say what March paid.
  amount          DECIMAL(10,2)   NOT NULL,
  fee             DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
  net_amount      DECIMAL(10,2)   NOT NULL,

  -- requested  the driver asked; THE WALLET IS ALREADY DEBITED
  -- sent       money has left; provider_ref holds the transfer
  -- failed     it did not leave; the wallet has been credited back
  -- cancelled  withdrawn before sending; credited back
  status          VARCHAR(16)     NOT NULL DEFAULT 'requested',

  -- 'gcash' | 'bank'. The destination is the DRIVER'S, never ours.
  destination     VARCHAR(16)     NOT NULL,
  account_ref     VARCHAR(64)     NOT NULL,   -- mask this in every log
  account_name    VARCHAR(120)    NOT NULL,

  provider_ref    VARCHAR(64)     NULL,       -- PayMongo transfer id
  failure_reason  VARCHAR(255)    NULL,

  requested_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at      DATETIME        NULL,

  -- The app sends this, generated once when the sheet opens and reused by
  -- every retry inside it. Two taps on a slow connection are ONE payout.
  -- Same defence 012 built for top-ups, and it matters more here because
  -- this direction cannot be undone.
  idempotency_key CHAR(36)        NOT NULL,

  PRIMARY KEY (payout_id),
  UNIQUE KEY driver_payouts_idem_uk (driver_id, idempotency_key),
  KEY driver_payouts_driver_idx (driver_id, requested_at DESC),
  KEY driver_payouts_status_idx (status, requested_at)

  -- , CONSTRAINT driver_payouts_driver_fk FOREIGN KEY (driver_id) REFERENCES drivers(driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ── The ledger learns a fifth kind ───────────────────────────────── */
-- Re-stated in full rather than appended, the only way MySQL takes it, and
-- the way 013 did it.
ALTER TABLE wallet_ledger
  MODIFY COLUMN kind
    ENUM('topup','commission','adjustment','fare','payout') NOT NULL;

/* ── One ledger row per payout, enforced by the database ──────────── */
-- Mirrors topup_id. NULL on every row that is not a payout, and MySQL
-- allows any number of NULLs in a unique index — so payouts do not collide
-- with each other on trip_id, nor commissions on payout_id.
ALTER TABLE wallet_ledger
  ADD COLUMN payout_id CHAR(36) NULL AFTER topup_id,
  ADD UNIQUE KEY wallet_ledger_payout_uk (payout_id);
