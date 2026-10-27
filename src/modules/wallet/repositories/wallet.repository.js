const { randomUUID } = require("crypto");
const pool = require("../../../config/db");

/**
 * The float, its movements, and the two writes that may change it.
 *
 * EVERY CREDIT AND DEBIT IN HERE IS IDEMPOTENT, enforced by the unique
 * indexes in migrations/012_wallet.sql rather than by checking first and
 * writing after. PayMongo retries webhooks, two deliveries can arrive at
 * once, and a check-then-act between them credits twice. Money invented by
 * a network retry is indistinguishable afterwards from money somebody paid.
 */

const TOPUP_COLUMNS = `
  topup_id, driver_id, amount, method, status,
  source_ref, payment_ref, checkout_url, failure_reason,
  created_at, paid_at`;

async function balanceOf(driverId) {
  const [rows] = await pool.query(
    `SELECT wallet_balance FROM drivers WHERE driver_id = :driverId LIMIT 1`,
    { driverId },
  );
  return rows[0] ? Number(rows[0].wallet_balance) : null;
}

async function createTopup({ driverId, amount, method, sourceRef, checkoutUrl }) {
  const topupId = randomUUID();
  await pool.query(
    `INSERT INTO driver_topups
       (topup_id, driver_id, amount, method, status, source_ref, checkout_url)
     VALUES (:topupId, :driverId, :amount, :method, 'pending', :sourceRef, :checkoutUrl)`,
    { topupId, driverId, amount, method, sourceRef: sourceRef || null, checkoutUrl: checkoutUrl || null },
  );
  const [rows] = await pool.query(
    `SELECT ${TOPUP_COLUMNS} FROM driver_topups WHERE topup_id = :topupId`,
    { topupId },
  );
  return rows[0];
}

async function findTopupBySource(sourceRef) {
  const [rows] = await pool.query(
    `SELECT ${TOPUP_COLUMNS} FROM driver_topups WHERE source_ref = :sourceRef LIMIT 1`,
    { sourceRef },
  );
  return rows[0] || null;
}

async function markTopupFailed(topupId, reason) {
  await pool.query(
    `UPDATE driver_topups
        SET status = 'failed', failure_reason = :reason
      WHERE topup_id = :topupId AND status <> 'paid'`,
    { topupId, reason: reason ? String(reason).slice(0, 500) : null },
  );
}

/**
 * Credits a paid top-up, exactly once, and returns the new balance — or
 * null when there was nothing left to do.
 *
 * In one transaction, and the FOR UPDATE is the point of it: two webhook
 * deliveries racing here would otherwise both read `pending` and both
 * credit. The second now waits for the first to commit, sees `paid`, and
 * does nothing.
 */
async function settleTopup({ topupId, paymentRef }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [locked] = await connection.query(
      `SELECT topup_id, driver_id, amount, method, status
         FROM driver_topups
        WHERE topup_id = :topupId
        FOR UPDATE`,
      { topupId },
    );
    const topup = locked[0];
    if (!topup || topup.status === "paid") {
      await connection.rollback();
      return null;
    }

    await connection.query(
      `UPDATE driver_topups
          SET status = 'paid', payment_ref = :paymentRef, paid_at = NOW()
        WHERE topup_id = :topupId`,
      { topupId, paymentRef: paymentRef || null },
    );
    await connection.query(
      `UPDATE drivers
          SET wallet_balance = wallet_balance + :amount
        WHERE driver_id = :driverId`,
      { amount: topup.amount, driverId: topup.driver_id },
    );
    const [after] = await connection.query(
      `SELECT wallet_balance FROM drivers WHERE driver_id = :driverId`,
      { driverId: topup.driver_id },
    );
    const balance = Number(after[0].wallet_balance);

    await connection.query(
      `INSERT IGNORE INTO wallet_ledger
         (entry_id, driver_id, kind, amount, balance_after, topup_id, note)
       VALUES (:entryId, :driverId, 'topup', :amount, :balance, :topupId, :note)`,
      {
        entryId: randomUUID(),
        driverId: topup.driver_id,
        amount: topup.amount,
        balance,
        topupId,
        note: `Top-up via ${topup.method}`,
      },
    );

    await connection.commit();
    return balance;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Takes the platform's cut out of the float when a ride completes.
 *
 * ONE DEBIT PER TRIP: the ledger's unique key on (trip_id, kind) refuses a
 * second, and the balance is only moved when the row actually inserted. A
 * completion replayed — a retry, a status set twice — therefore charges the
 * driver once.
 *
 * The balance is allowed to go NEGATIVE. Refusing the debit would mean a
 * ride that happened was never charged for, which is worse than a balance
 * the driver has to clear before they can go online again.
 */
async function chargeCommission({ driverId, tripId, amount, note }) {
  const cut = Math.round(Number(amount) * 100) / 100;
  if (!(cut > 0)) return null;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      `INSERT IGNORE INTO wallet_ledger
         (entry_id, driver_id, kind, amount, balance_after, trip_id, note)
       VALUES (:entryId, :driverId, 'commission', :amount, 0, :tripId, :note)`,
      {
        entryId: randomUUID(),
        driverId,
        amount: -cut,
        tripId,
        note: note || null,
      },
    );
    if (!result.affectedRows) {
      // Already charged for this trip.
      await connection.rollback();
      return null;
    }

    await connection.query(
      `UPDATE drivers SET wallet_balance = wallet_balance - :cut WHERE driver_id = :driverId`,
      { cut, driverId },
    );
    const [after] = await connection.query(
      `SELECT wallet_balance FROM drivers WHERE driver_id = :driverId`,
      { driverId },
    );
    const balance = Number(after[0].wallet_balance);

    // balance_after could not be known before the UPDATE above, so the row
    // is written with a placeholder and corrected inside the same
    // transaction. Nothing outside it ever observes the zero.
    await connection.query(
      `UPDATE wallet_ledger SET balance_after = :balance
        WHERE trip_id = :tripId AND kind = 'commission'`,
      { balance, tripId },
    );

    await connection.commit();
    return balance;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function ledgerFor(driverId, limit) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const [rows] = await pool.query(
    `SELECT entry_id, kind, amount, balance_after, trip_id, topup_id, note, created_at
       FROM wallet_ledger
      WHERE driver_id = :driverId
      ORDER BY created_at DESC, entry_id DESC
      LIMIT ${capped}`,
    { driverId },
  );
  return rows;
}

module.exports = {
  balanceOf,
  createTopup,
  findTopupBySource,
  markTopupFailed,
  settleTopup,
  chargeCommission,
  ledgerFor,
};
