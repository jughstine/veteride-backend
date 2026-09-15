const pool = require("../../../config/db");

/** Every column a vehicle is read by, so the shapes never drift apart. */
const VEHICLE_COLUMNS = `
  v.vehicle_id, v.driver_id, v.plate_number, v.vehicle_model,
  v.vehicle_type, v.vehicle_class, v.vehicle_color,
  v.verification_status, v.created_at, v.updated_at`;

/**
 * The one vehicle dispatch classifies this driver by.
 *
 * A driver may have several rows — a motorcycle sold last year, the car
 * they drive now — and exactly one of them decides which bookings they are
 * shown, so the choice is made here rather than left to whichever row the
 * database returns first. An approved vehicle outranks a pending one
 * because approval is the console saying the papers match the plate; among
 * equals the most recently updated wins, which is the one the driver last
 * told anybody about.
 */
async function findForDriver(driverId) {
  const [rows] = await pool.query(
    `SELECT ${VEHICLE_COLUMNS}
       FROM vehicles v
      WHERE v.driver_id = :driverId
      ORDER BY (v.verification_status = 'approved') DESC, v.updated_at DESC
      LIMIT 1`,
    { driverId },
  );
  return rows[0] || null;
}

async function findById(vehicleId) {
  const [rows] = await pool.query(
    `SELECT ${VEHICLE_COLUMNS} FROM vehicles v WHERE v.vehicle_id = :vehicleId LIMIT 1`,
    { vehicleId },
  );
  return rows[0] || null;
}

module.exports = { VEHICLE_COLUMNS, findForDriver, findById };
