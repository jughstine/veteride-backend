const pool = require("../../../config/db");

/**
 * Whether a driver is taking work.
 *
 * Its own table, keyed by driver_id, rather than a column on `drivers`:
 * this repository has no schema file for `drivers`, so nothing here is
 * allowed to alter it. The join costs a primary-key lookup.
 */

/** The switch as it stands. No row means the driver never touched it. */
async function find(driverId) {
  const [rows] = await pool.query(
    `SELECT driver_id, status, changed_at
       FROM driver_availability
      WHERE driver_id = :driverId
      LIMIT 1`,
    { driverId },
  );
  return rows[0] || null;
}

/** 'offline' for a driver who has never been seen, which is the truth. */
async function statusOf(driverId) {
  const row = await find(driverId);
  return row ? row.status : "offline";
}

/**
 * Writes the claim.
 *
 * Upsert and not UPDATE: the row is created the first time a driver goes
 * online, so signup does not have to know this table exists and a driver
 * who registered before it did needs no backfill.
 */
async function set(driverId, status) {
  await pool.query(
    `INSERT INTO driver_availability (driver_id, status)
     VALUES (:driverId, :status)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       changed_at = NOW()`,
    { driverId, status },
  );
  return status;
}

module.exports = { find, statusOf, set };
