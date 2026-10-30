-- =====================================================================
-- A fare the gateway collected, credited to the driver.
-- =====================================================================
--
-- Until now the float only ever went one way: a driver topped it up and
-- VeteRide's 12% came out of it, because the passenger settled the fare
-- with the driver in cash and no gateway was involved at all.
--
-- The owner's addition, 30 Oct 2026: a passenger may pay the fare through
-- QR Ph instead. When they do, the money lands in VeteRide's PayMongo
-- account rather than in the driver's hand, so the driver has to be
-- credited for it — and the commission must NOT also be taken out of their
-- float, because it was already withheld at source. One ride is paid for
-- once, whichever way round the money travelled.
--
--   cash ride     fare -> driver's hand       commission OUT of the float
--   QR Ph ride    fare -> VeteRide's PayMongo fare minus 12% INTO the float
--
-- So `kind` grows a fourth value. It is a separate kind rather than a
-- positive 'adjustment' because an adjustment is something a human decided
-- and a fare is something a passenger paid, and a statement that cannot
-- tell those apart is a statement nobody can audit.
--
-- NOTHING ELSE CHANGES. wallet_ledger_trip_commission_uk is (trip_id, kind),
-- so a 'fare' row and a 'commission' row for the same trip do not collide
-- with each other, and neither can be written twice by a retried webhook.
-- That index is already the whole defence against double-crediting, and it
-- covers this new kind for free.
--
-- Safe to re-run: both statements are idempotent in effect. The ALTER
-- re-states the full enum rather than appending, which is the only way
-- MySQL takes it.

/* ── 'fare': money a passenger paid, less the platform's cut ──────── */
ALTER TABLE wallet_ledger
  MODIFY COLUMN kind
    ENUM('topup','commission','adjustment','fare') NOT NULL;

/* ── Finding a payment by the gateway's own reference ─────────────── */
--
-- The webhook arrives naming PayMongo's payment intent and nothing else, so
-- the row it belongs to has to be found by that reference. Without an index
-- this is a table scan on every delivery, and PayMongo retries.
--
-- Not UNIQUE. A failed first attempt and the retry that follows are two
-- different intents against the same ride, and the older reference stays on
-- the row it was written to; uniqueness here would refuse the second
-- attempt rather than let the passenger try again.
ALTER TABLE payments
  ADD INDEX payments_gateway_ref_idx (payment_gateway_ref);
