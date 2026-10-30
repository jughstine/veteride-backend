const crypto = require("crypto");
const pool = require("../../../config/db");

/**
 * The money of a finished ride.
 *
 * One row per trip, written at the drop-off and never again by this
 * module: a receipt is a record of what happened, and a record that is
 * recomputed on every read is a number, not a receipt. The console's
 * payments board and its refund button are the other writers.
 */

/** Everything the console and a rider's receipt read. */
const PAYMENT_COLUMNS = `
  p.payment_id, p.trip_id, p.rider_id,
  p.amount, p.payment_method, p.status, p.settled_with,
  p.platform_fee, p.driver_earnings, p.tip_amount, p.discount_amount,
  p.refund_amount, p.refund_reason, p.payment_gateway_ref,
  p.paid_at, p.created_at, p.updated_at`;

/**
 * Records the fare of one completed ride.
 *
 * Idempotent on the trip: trip_id is UNIQUE and a second call leaves the
 * first record alone rather than failing the request that made it. The
 * completing UPDATE is already conditional, so this can only be reached
 * twice by a retry — and a retry must not turn one ride into two receipts
 * or into a 500 on a ride that finished perfectly well.
 *
 * `status` and `settledWith` are the caller's to decide and are not
 * defaulted here, because the pair is the claim the row makes about whose
 * money moved. The gateway reference stays NULL: there is no gateway.
 */
async function recordForTrip({
  tripId,
  riderId,
  amount,
  method,
  status,
  settledWith,
  platformFee,
  driverEarnings,
  paidAt = null,
}) {
  const paymentId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payments (
       payment_id, trip_id, rider_id,
       amount, payment_method, status, settled_with,
       platform_fee, driver_earnings, paid_at
     ) VALUES (
       :paymentId, :tripId, :riderId,
       :amount, :method, :status, :settledWith,
       :platformFee, :driverEarnings, :paidAt
     )
     ON DUPLICATE KEY UPDATE payment_id = payment_id`,
    {
      paymentId,
      tripId,
      riderId,
      amount,
      method,
      status,
      settledWith,
      platformFee,
      driverEarnings,
      paidAt,
    },
  );
  return findForTrip(tripId);
}

/**
 * Adds the passenger's tip to the ride's receipt.
 *
 * `tip_amount IS NULL` is the guard, and it is the same lock as the one on
 * trips.rated_at: a tip is part of the rating, the rating can be left
 * once, and a replayed write must not add the money twice. Two columns
 * move with it — the amount, because that is what was charged, and the
 * driver's earnings, because the whole tip is theirs and the platform
 * takes no commission on a gift.
 */
async function addTip(tripId, tip) {
  const [result] = await pool.query(
    `UPDATE payments
        SET tip_amount = :tip,
            amount = amount + :tip,
            driver_earnings = COALESCE(driver_earnings, 0) + :tip
      WHERE trip_id = :tripId
        AND tip_amount IS NULL`,
    { tripId, tip },
  );
  return result.affectedRows === 1;
}

/** The receipt for one ride, or null if it never reached a drop-off. */
/**
 * Puts a gateway's reference on a ride's receipt and leaves it pending.
 *
 * Written BEFORE the money arrives, so the webhook has a row to find. The
 * row therefore says `pending` and claims nothing: the CHECK in
 * 005_fares.sql forbids a 'completed' gateway row without a reference, and
 * a reference without a confirmed payment would be a receipt for a payment
 * nobody took.
 *
 * Upserts, because a passenger whose first attempt expired must be able to
 * try again: the second intent replaces the first on the same ride, and
 * trip_id stays UNIQUE so one ride still has one receipt.
 */
async function openGatewayPayment({
  tripId,
  riderId,
  amount,
  method,
  platformFee,
  driverEarnings,
  gatewayRef,
}) {
  await pool.query(
    `INSERT INTO payments (
       payment_id, trip_id, rider_id,
       amount, payment_method, status, settled_with,
       platform_fee, driver_earnings, payment_gateway_ref
     ) VALUES (
       :paymentId, :tripId, :riderId,
       :amount, :method, 'pending', 'gateway',
       :platformFee, :driverEarnings, :gatewayRef
     )
     ON DUPLICATE KEY UPDATE
       -- Never touches a row the gateway has already settled. A late
       -- "pay again" tap must not reopen a ride that is paid for.
       amount              = IF(status = 'completed', amount, VALUES(amount)),
       payment_method      = IF(status = 'completed', payment_method, VALUES(payment_method)),
       settled_with        = IF(status = 'completed', settled_with, VALUES(settled_with)),
       platform_fee        = IF(status = 'completed', platform_fee, VALUES(platform_fee)),
       driver_earnings     = IF(status = 'completed', driver_earnings, VALUES(driver_earnings)),
       payment_gateway_ref = IF(status = 'completed', payment_gateway_ref, VALUES(payment_gateway_ref))`,
    {
      paymentId: crypto.randomUUID(),
      tripId,
      riderId,
      amount,
      method,
      platformFee,
      driverEarnings,
      gatewayRef,
    },
  );
  return findForTrip(tripId);
}

/** The ride's receipt that carries this gateway reference, if any. */
async function findByGatewayRef(gatewayRef) {
  const [rows] = await pool.query(
    `SELECT ${PAYMENT_COLUMNS}, t.driver_id
       FROM payments p
       JOIN trips t ON t.trip_id = p.trip_id
      WHERE p.payment_gateway_ref = :gatewayRef
      ORDER BY p.created_at DESC
      LIMIT 1`,
    { gatewayRef },
  );
  return rows[0] || null;
}

/**
 * Marks a gateway payment paid, once.
 *
 * The `status <> 'completed'` guard is what makes a retried webhook a
 * no-op: affectedRows tells the caller whether THIS delivery was the one
 * that settled it, so the wallet credit happens exactly once.
 */
async function completeGatewayPayment({ tripId, gatewayRef }) {
  const [result] = await pool.query(
    `UPDATE payments
        SET status = 'completed',
            payment_gateway_ref = :gatewayRef,
            paid_at = COALESCE(paid_at, NOW())
      WHERE trip_id = :tripId
        AND status <> 'completed'`,
    { tripId, gatewayRef },
  );
  return result.affectedRows > 0;
}

async function findForTrip(tripId) {
  const [rows] = await pool.query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.trip_id = :tripId LIMIT 1`,
    { tripId },
  );
  return rows[0] || null;
}

module.exports = {
  PAYMENT_COLUMNS,
  recordForTrip,
  openGatewayPayment,
  findByGatewayRef,
  completeGatewayPayment,
  addTip,
  findForTrip,
};
