const { randomUUID } = require("crypto");
const pool = require("../../../config/db");

/**
 * Taking money back out. The mirror of driver_topups, and the direction
 * that cannot be undone.
 *
 * 012 was written for a prepaid float: money the driver paid in, that only
 * ever went down as commission came out. Since 013 the wallet also receives
 * the driver's EARNINGS, so the balance is money we owe and it grows with
 * every ride. A driver who cannot withdraw it has not been paid. This is
 * payroll, not a feature.
 *
 * EVERY GUARD IN HERE IS IN SQL RATHER THAN IN JAVASCRIPT, for the same
 * reason the top-up side is: chargeCommission is debiting the same column
 * from the ride that just finished, and a check-then-act between the two
 * loses that race. Money sent twice is indistinguishable afterwards from
 * money owed twice.
 *
 * See migrations/014_payouts.sql and docs/the-sql-that-is-left.md.
 */

const PAYOUT_COLUMNS = `
  payout_id, driver_id, amount, fee, net_amount, status,
  destination, account_ref, account_name, provider_ref,
  failure_reason, requested_at, settled_at`;

/**
 * The driver asks for money out.
 *
 * Returns one of:
 *   { payout }                    created, wallet already debited
 *   { payout, replayed: true }    same idempotency key, nothing new happened
 *   { reason: "<CODE>" }          refused, nothing written
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. The insert goes first so that the
 * pending count below includes this request — two concurrent calls then
 * cannot both see "none in flight". The debit goes last so that a refusal
 * costs nothing. All of it in one transaction, so a refusal at any step
 * leaves the row behind as well.
 */
async function requestPayout({
  driverId,
  amount,
  fee,
  destination,
  accountRef,
  accountName,
  idempotencyKey,
  maxPerDay = null,
}) {
  const net = Math.round((Number(amount) - Number(fee)) * 100) / 100;
  const payoutId = randomUUID();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // INSERT IGNORE against driver_payouts_idem_uk (driver_id,
    // idempotency_key). affectedRows = 0 is a RETRY, not a second request:
    // the app generates the key once when the sheet opens and reuses it for
    // every retry inside it, so two taps on a slow connection are one
    // payout. The caller answers 200 with the existing row, never a 409.
    const [inserted] = await connection.query(
      `INSERT IGNORE INTO driver_payouts
         (payout_id, driver_id, amount, fee, net_amount, status,
          destination, account_ref, account_name, idempotency_key)
       VALUES (:payoutId, :driverId, :amount, :fee, :net, 'requested',
               :destination, :accountRef, :accountName, :idempotencyKey)`,
      {
        payoutId,
        driverId,
        amount,
        fee,
        net,
        destination,
        accountRef,
        accountName,
        idempotencyKey,
      },
    );

    if (!inserted.affectedRows) {
      const [existing] = await connection.query(
        `SELECT ${PAYOUT_COLUMNS} FROM driver_payouts
          WHERE driver_id = :driverId AND idempotency_key = :idempotencyKey`,
        { driverId, idempotencyKey },
      );
      await connection.rollback();
      return { payout: existing[0] || null, replayed: true };
    }

    // One in flight at a time. Counted INSIDE the transaction and AFTER our
    // own insert, so the count includes this row: > 1 means somebody else's
    // is already waiting. Two concurrent requests cannot both pass.
    const [pending] = await connection.query(
      `SELECT COUNT(*) AS n FROM driver_payouts
        WHERE driver_id = :driverId AND status = 'requested'`,
      { driverId },
    );
    if (Number(pending[0].n) > 1) {
      await connection.rollback();
      return { reason: "PAYOUT_PENDING" };
    }

    // An optional ceiling on what may leave in a day, counting everything
    // that has not failed. Unset means no limit — the mechanism exists so
    // the figure can be set later without a deploy, the same discipline as
    // TOPUP_METHODS.
    if (maxPerDay !== null) {
      const [today] = await connection.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM driver_payouts
          WHERE driver_id = :driverId
            AND status IN ('requested', 'sent')
            AND requested_at >= CURDATE()`,
        { driverId },
      );
      if (Number(today[0].total) > Number(maxPerDay)) {
        await connection.rollback();
        return { reason: "DAILY_LIMIT" };
      }
    }

    // DEBIT ON REQUEST, not on settle, and the guard is the WHERE clause.
    // affectedRows = 0 is insufficient balance — including the case where
    // a commission landed between the driver reading their balance and
    // this statement running.
    const [debit] = await connection.query(
      `UPDATE drivers SET wallet_balance = wallet_balance - :amount
        WHERE driver_id = :driverId AND wallet_balance >= :amount`,
      { driverId, amount },
    );
    if (!debit.affectedRows) {
      await connection.rollback();
      return { reason: "INSUFFICIENT_BALANCE" };
    }

    const [after] = await connection.query(
      `SELECT wallet_balance FROM drivers WHERE driver_id = :driverId`,
      { driverId },
    );
    const balance = Number(after[0].wallet_balance);

    // NEGATIVE amount — the convention chargeCommission already uses for a
    // debit. The unique key on payout_id makes a replay a no-op.
    await connection.query(
      `INSERT IGNORE INTO wallet_ledger
         (entry_id, driver_id, kind, amount, balance_after, payout_id, note)
       VALUES (:entryId, :driverId, 'payout', :amount, :balance,
               :payoutId, :note)`,
      {
        entryId: randomUUID(),
        driverId,
        amount: -Number(amount),
        balance,
        payoutId,
        note: `Cash-out to ${destination}`,
      },
    );

    const [rows] = await connection.query(
      `SELECT ${PAYOUT_COLUMNS} FROM driver_payouts
        WHERE payout_id = :payoutId`,
      { payoutId },
    );

    await connection.commit();
    return { payout: rows[0], balance };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

/** This driver's own history, newest first. */
async function listForDriver(driverId, limit) {
  const [rows] = await pool.query(
    `SELECT ${PAYOUT_COLUMNS} FROM driver_payouts
      WHERE driver_id = :driverId
      ORDER BY requested_at DESC
      LIMIT :limit`,
    { driverId, limit },
  );
  return rows;
}

/**
 * The queue the console works through, oldest first — a payout that has
 * been waiting longest is the one to send next.
 */
async function listForAdmin({ status, limit, offset }) {
  const [rows] = await pool.query(
    `SELECT p.payout_id, p.driver_id, p.amount, p.fee, p.net_amount,
            p.status, p.destination, p.account_ref, p.account_name,
            p.provider_ref, p.failure_reason, p.requested_at, p.settled_at,
            d.full_name AS driver_name
       FROM driver_payouts p
       JOIN drivers d ON d.driver_id = p.driver_id
      WHERE (:status IS NULL OR p.status = :status)
      ORDER BY p.requested_at ASC
      LIMIT :limit OFFSET :offset`,
    { status: status || null, limit, offset },
  );
  return rows;
}

async function findById(payoutId) {
  const [rows] = await pool.query(
    `SELECT ${PAYOUT_COLUMNS} FROM driver_payouts WHERE payout_id = :payoutId`,
    { payoutId },
  );
  return rows[0] || null;
}

/**
 * The money has gone. Records the transfer and closes the row.
 *
 * The status guard is what makes this safe to call twice: affectedRows = 0
 * means somebody already settled or failed it, and the caller answers with
 * the row as it stands rather than overwriting a decision.
 */
async function settle({ payoutId, providerRef }) {
  const [result] = await pool.query(
    `UPDATE driver_payouts
        SET status = 'sent', provider_ref = :providerRef, settled_at = NOW()
      WHERE payout_id = :payoutId AND status = 'requested'`,
    { payoutId, providerRef: providerRef || null },
  );
  return result.affectedRows === 1;
}

/**
 * The money did not go. Credits it back IN THE SAME TRANSACTION as the
 * status change — otherwise it has left the driver's view without arriving
 * anywhere, and only the ledger would know.
 */
async function fail({ payoutId, reason }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // THE STATUS CHANGE IS THE GUARD. affectedRows = 0 means this was
    // already settled or already failed, and the credit below must not run
    // — a second call would otherwise hand the driver the money twice.
    const [changed] = await connection.query(
      `UPDATE driver_payouts
          SET status = 'failed', failure_reason = :reason, settled_at = NOW()
        WHERE payout_id = :payoutId AND status = 'requested'`,
      { payoutId, reason: reason ? String(reason).slice(0, 255) : null },
    );
    if (!changed.affectedRows) {
      await connection.rollback();
      return false;
    }

    const [rows] = await connection.query(
      `SELECT driver_id, amount FROM driver_payouts
        WHERE payout_id = :payoutId`,
      { payoutId },
    );
    const { driver_id: driverId, amount } = rows[0];

    await connection.query(
      `UPDATE drivers SET wallet_balance = wallet_balance + :amount
        WHERE driver_id = :driverId`,
      { amount, driverId },
    );
    const [after] = await connection.query(
      `SELECT wallet_balance FROM drivers WHERE driver_id = :driverId`,
      { driverId },
    );

    // kind = 'adjustment' WITH NO payout_id, NOT kind = 'payout'.
    // wallet_ledger_payout_uk is unique on payout_id — one row per payout —
    // so a reversal written as ('payout', :payoutId) collides with the
    // debit row above and takes this whole transaction down with it.
    await connection.query(
      `INSERT INTO wallet_ledger
         (entry_id, driver_id, kind, amount, balance_after, note)
       VALUES (:entryId, :driverId, 'adjustment', :amount, :balance, :note)`,
      {
        entryId: randomUUID(),
        driverId,
        amount,
        balance: Number(after[0].wallet_balance),
        note: `Cash-out ${payoutId} failed`,
      },
    );

    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  requestPayout,
  listForDriver,
  listForAdmin,
  findById,
  settle,
  fail,
};
