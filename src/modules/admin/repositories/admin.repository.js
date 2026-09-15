const crypto = require("crypto");
const pool = require("../../../config/db");
const { getRoleConfig } = require("../../auth/repositories/role-tables");

/**
 * Every read the console renders and every write it performs, in one place.
 *
 * Two rules run through all of it:
 *
 *   * NO password hash and NO token EVER leaves here. Every SELECT is an
 *     explicit column list, never `SELECT *`, so a hash cannot escape by a
 *     column being added to a table later. The handover `pin` on a trip is
 *     excluded for the same reason: the console is not a party to a ride.
 *
 *   * An account is (id, role), never id alone. `customers.user_id`,
 *     `drivers.driver_id` and `admins.admin_id` are three separate
 *     AUTO_INCREMENT sequences, so customer 1 and driver 1 are different
 *     people who share a number. Anything that identifies an account takes
 *     the role and reads the table that role maps to.
 */

/** DECIMAL arrives from mysql2 as a string; the API promises numbers. */
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** The same, but a missing money figure is 0 rather than null (for sums). */
const money = (v) => (v === null || v === undefined ? 0 : Number(v));

// The states a ride is still happening in — the console's "live" trips.
const LIVE_STATUSES = ["requested", "matched", "en_route_pickup", "in_progress"];

// -----------------------------------------------------------------------
// Overview
// -----------------------------------------------------------------------

/**
 * The dashboard's figures, each a query and none a literal.
 *
 * Grouped counts come back as rows and are folded into an object here so the
 * service reads a shape rather than an array. Money is the only DECIMAL in
 * it and passes through money().
 */
async function overview() {
  const [[riders]] = await pool.query(
    "SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL",
  );

  const [[drivers]] = await pool.query(
    "SELECT COUNT(*) AS n FROM drivers WHERE deleted_at IS NULL",
  );

  const [driverVerification] = await pool.query(
    `SELECT verification_status AS k, COUNT(*) AS n
       FROM drivers
      WHERE deleted_at IS NULL
      GROUP BY verification_status`,
  );

  // A driver with no availability row has never touched the switch, which is
  // 'offline' — folded in with COALESCE so the three states always add up to
  // the driver count.
  const [driverAvailability] = await pool.query(
    `SELECT COALESCE(av.status, 'offline') AS k, COUNT(*) AS n
       FROM drivers d
       LEFT JOIN driver_availability av ON av.driver_id = d.driver_id
      WHERE d.deleted_at IS NULL
      GROUP BY COALESCE(av.status, 'offline')`,
  );

  const [liveTrips] = await pool.query(
    `SELECT status AS k, COUNT(*) AS n
       FROM trips
      WHERE status IN (:live)
      GROUP BY status`,
    { live: LIVE_STATUSES },
  );

  // "Today" is the database's day, not the reader's: the pool runs at +08:00
  // and CURDATE() answers in it, so a ride finished at 23:30 Manila is
  // counted today whatever the clock on the machine reading this says.
  const [[completed]] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM trips
      WHERE status = 'completed'
        AND dropoff_at >= CURDATE()
        AND dropoff_at <  CURDATE() + INTERVAL 1 DAY`,
  );

  const [[gross]] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payments
      WHERE status = 'completed'
        AND COALESCE(paid_at, created_at) >= CURDATE()
        AND COALESCE(paid_at, created_at) <  CURDATE() + INTERVAL 1 DAY`,
  );

  const [[pendingDocs]] = await pool.query(
    `SELECT COUNT(*) AS n
       FROM uploads
      WHERE owner_role = 'driver'
        AND deleted_at IS NULL
        AND kind IN ('license_photo', 'or_cr_photo')
        AND review_status = 'pending'`,
  );

  return {
    riders: Number(riders.n),
    drivers: Number(drivers.n),
    driverVerification,
    driverAvailability,
    liveTrips,
    completedToday: Number(completed.n),
    grossToday: money(gross.total),
    pendingDocuments: Number(pendingDocs.n),
  };
}

// -----------------------------------------------------------------------
// Riders
// -----------------------------------------------------------------------

/** The WHERE for the riders list, shared by the page and its COUNT. */
const RIDERS_WHERE = `
  WHERE deleted_at IS NULL
    AND (:q IS NULL OR full_name LIKE :like OR phone_number LIKE :like OR email LIKE :like)`;

async function listRiders({ q, limit, offset }) {
  const params = { q: q ?? null, like: q ? `%${q}%` : null, limit, offset };
  const [rows] = await pool.query(
    `SELECT user_id, full_name, email, phone_number, status,
            total_trips, wallet_balance, is_verified, created_at
       FROM customers
       ${RIDERS_WHERE}
      ORDER BY created_at DESC
      LIMIT :limit OFFSET :offset`,
    params,
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM customers ${RIDERS_WHERE}`,
    params,
  );
  return { rows, total: Number(total) };
}

// -----------------------------------------------------------------------
// Drivers
// -----------------------------------------------------------------------

// The one vehicle dispatch would classify this driver by, chosen the same
// way vehicle.repository.findForDriver chooses it: an approved vehicle
// outranks a pending one, and the most recently updated breaks the tie.
const DRIVER_VEHICLE_SUBQUERY = `
  (SELECT v2.vehicle_id FROM vehicles v2
    WHERE v2.driver_id = d.driver_id
    ORDER BY (v2.verification_status = 'approved') DESC, v2.updated_at DESC
    LIMIT 1)`;

// Rating and completed-trip count are DERIVED from the rides themselves, not
// read from a stored counter on `drivers`: this repository carries no schema
// for that table, and a counter somebody updates by hand is one that
// disagrees with the receipts. NULL rating for a driver nobody has rated.
const DRIVERS_FROM = `
  FROM drivers d
  LEFT JOIN driver_availability av ON av.driver_id = d.driver_id
  LEFT JOIN vehicles v ON v.vehicle_id = ${DRIVER_VEHICLE_SUBQUERY}`;

const DRIVERS_WHERE = `
  WHERE d.deleted_at IS NULL
    AND (:q IS NULL OR d.full_name LIKE :like OR d.phone_number LIKE :like OR d.email LIKE :like)
    AND (:verification IS NULL OR d.verification_status = :verification)
    AND (:availability IS NULL OR COALESCE(av.status, 'offline') = :availability)`;

const DRIVER_COLUMNS = `
  d.driver_id, d.full_name, d.email, d.phone_number, d.status,
  d.verification_status, d.license_number,
  COALESCE(av.status, 'offline') AS availability_status,
  v.vehicle_id, v.plate_number, v.vehicle_model, v.vehicle_type,
  v.vehicle_class, v.vehicle_color,
  v.verification_status AS vehicle_verification_status,
  (SELECT ROUND(AVG(t.rating), 2) FROM trips t
     WHERE t.driver_id = d.driver_id AND t.rating IS NOT NULL) AS rating,
  (SELECT COUNT(*) FROM trips t
     WHERE t.driver_id = d.driver_id AND t.rating IS NOT NULL) AS ratings,
  (SELECT COUNT(*) FROM trips t
     WHERE t.driver_id = d.driver_id AND t.status = 'completed') AS trips_completed`;

async function listDrivers({ q, verification, availability, limit, offset }) {
  const params = {
    q: q ?? null,
    like: q ? `%${q}%` : null,
    verification: verification ?? null,
    availability: availability ?? null,
    limit,
    offset,
  };
  const [rows] = await pool.query(
    `SELECT ${DRIVER_COLUMNS}
       ${DRIVERS_FROM}
       ${DRIVERS_WHERE}
      ORDER BY d.driver_id DESC
      LIMIT :limit OFFSET :offset`,
    params,
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total ${DRIVERS_FROM} ${DRIVERS_WHERE}`,
    params,
  );
  return { rows, total: Number(total) };
}

/** One driver in the same shape as a list row, for a write to return. */
async function getDriver(driverId) {
  const [rows] = await pool.query(
    `SELECT ${DRIVER_COLUMNS}
       ${DRIVERS_FROM}
      WHERE d.driver_id = :driverId AND d.deleted_at IS NULL
      LIMIT 1`,
    { driverId },
  );
  return rows[0] || null;
}

// -----------------------------------------------------------------------
// Trips
// -----------------------------------------------------------------------

// The handover `pin` is deliberately absent. The console is not a party to a
// ride, and the PIN is the passenger's half of starting one.
const TRIP_LIST_COLUMNS = `
  t.trip_id, t.status, t.pickup_address, t.dropoff_address,
  t.distance_km, t.estimated_fare, t.final_fare,
  t.vehicle_class, t.service, t.payment_method,
  t.requested_at, t.matched_at, t.pickup_at, t.dropoff_at, t.updated_at,
  c.full_name AS rider_name, dr.full_name AS driver_name`;

const TRIPS_FROM = `
  FROM trips t
  LEFT JOIN customers c ON c.user_id = t.user_id
  LEFT JOIN drivers dr ON dr.driver_id = t.driver_id`;

async function listTrips({ status, limit, offset }) {
  const params = { status: status ?? null, limit, offset };
  const [rows] = await pool.query(
    `SELECT ${TRIP_LIST_COLUMNS}
       ${TRIPS_FROM}
      WHERE (:status IS NULL OR t.status = :status)
      ORDER BY t.requested_at DESC
      LIMIT :limit OFFSET :offset`,
    params,
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM trips t WHERE (:status IS NULL OR t.status = :status)`,
    { status: status ?? null },
  );
  return { rows, total: Number(total) };
}

/**
 * One trip, joined to both parties, its vehicle and its payment.
 *
 * By primary key, and never the whole ledger: the sheet reads one row rather
 * than pulling every trip and every payment to pick one out. No `pin`.
 */
async function getTrip(tripId) {
  const [rows] = await pool.query(
    `SELECT t.trip_id, t.status,
            t.pickup_address, t.pickup_lat, t.pickup_lng,
            t.dropoff_address, t.dropoff_lat, t.dropoff_lng,
            t.distance_km, t.estimated_minutes, t.estimated_fare, t.final_fare,
            t.actual_duration_min, t.vehicle_class, t.service, t.payment_method,
            t.rating, t.rating_comment, t.tip_amount, t.rated_at,
            t.cancelled_by, t.cancel_reason,
            t.requested_at, t.matched_at, t.pickup_at, t.dropoff_at, t.updated_at,
            c.user_id AS rider_id, c.full_name AS rider_name, c.phone_number AS rider_phone,
            dr.driver_id, dr.full_name AS driver_name, dr.phone_number AS driver_phone,
            v.vehicle_id, v.plate_number, v.vehicle_model, v.vehicle_type,
            v.vehicle_class AS registered_vehicle_class,
            p.payment_id, p.amount AS payment_amount, p.payment_method AS payment_method_used,
            p.status AS payment_status, p.settled_with,
            p.platform_fee, p.driver_earnings, p.tip_amount AS payment_tip,
            p.discount_amount, p.refund_amount, p.refund_reason, p.payment_gateway_ref,
            p.paid_at, p.created_at AS payment_created_at
       FROM trips t
       LEFT JOIN customers c ON c.user_id = t.user_id
       LEFT JOIN drivers dr ON dr.driver_id = t.driver_id
       LEFT JOIN vehicles v ON v.vehicle_id = t.vehicle_id
       LEFT JOIN payments p ON p.trip_id = t.trip_id
      WHERE t.trip_id = :tripId
      LIMIT 1`,
    { tripId },
  );
  return rows[0] || null;
}

/** Both parties, for freeing a driver and routing a realtime event. */
async function partiesOf(tripId) {
  const [rows] = await pool.query(
    "SELECT user_id, driver_id, status FROM trips WHERE trip_id = :tripId LIMIT 1",
    { tripId },
  );
  return rows[0] || null;
}

/**
 * Force-cancels a live ride, as the system.
 *
 * The console's escape hatch for a ride that is stuck — a driver whose phone
 * died in_progress, which neither side may cancel by the owner's rule. It is
 * recorded as cancelled_by 'system' with the operator's reason, exactly as
 * the abandoned-ride sweeper records its own. The WHERE keeps it to a ride
 * that is actually live, so a second click cannot re-cancel a finished one.
 */
async function forceCancelTrip(tripId, reason) {
  const [result] = await pool.query(
    `UPDATE trips
        SET status = 'cancelled',
            cancelled_by = 'system',
            cancel_reason = :reason
      WHERE trip_id = :tripId
        AND status IN (:live)`,
    { tripId, reason, live: LIVE_STATUSES },
  );
  return result.affectedRows === 1;
}

// -----------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------

const PAYMENT_COLUMNS = `
  p.payment_id, p.trip_id, p.rider_id, p.amount, p.payment_method, p.status,
  p.settled_with, p.platform_fee, p.driver_earnings, p.tip_amount,
  p.discount_amount, p.refund_amount, p.refund_reason, p.payment_gateway_ref,
  p.paid_at, p.created_at, p.updated_at,
  c.full_name AS rider_name`;

const PAYMENTS_WHERE = `
  WHERE (:status IS NULL OR p.status = :status)
    AND (:q IS NULL OR c.full_name LIKE :like OR p.payment_id LIKE :like OR p.trip_id LIKE :like)`;

async function listPayments({ status, q, limit, offset }) {
  const params = {
    status: status ?? null,
    q: q ?? null,
    like: q ? `%${q}%` : null,
    limit,
    offset,
  };
  const [rows] = await pool.query(
    `SELECT ${PAYMENT_COLUMNS}
       FROM payments p
       LEFT JOIN customers c ON c.user_id = p.rider_id
       ${PAYMENTS_WHERE}
      ORDER BY p.created_at DESC
      LIMIT :limit OFFSET :offset`,
    params,
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM payments p
       LEFT JOIN customers c ON c.user_id = p.rider_id
       ${PAYMENTS_WHERE}`,
    params,
  );
  return { rows, total: Number(total) };
}

// -----------------------------------------------------------------------
// Documents (driver verification uploads)
// -----------------------------------------------------------------------

const DOCUMENTS_WHERE = `
  WHERE u.owner_role = 'driver'
    AND u.deleted_at IS NULL
    AND u.kind IN ('license_photo', 'or_cr_photo')
    AND (:driverId IS NULL OR u.owner_id = :driverId)
    AND (:status IS NULL OR u.review_status = :status)`;

async function listDocuments({ driverId, status, limit, offset }) {
  const params = {
    driverId: driverId ?? null,
    status: status ?? null,
    limit,
    offset,
  };
  const [rows] = await pool.query(
    `SELECT u.upload_id, u.owner_id AS driver_id, u.kind,
            u.review_status, u.review_notes, u.reviewed_by, u.reviewed_at,
            u.mime_type, u.size_bytes, u.original_name, u.uploaded_at,
            d.full_name AS driver_name,
            d.verification_status AS driver_verification_status
       FROM uploads u
       LEFT JOIN drivers d ON d.driver_id = u.owner_id
       ${DOCUMENTS_WHERE}
      ORDER BY (u.review_status = 'pending') DESC, u.uploaded_at DESC
      LIMIT :limit OFFSET :offset`,
    params,
  );
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM uploads u
       ${DOCUMENTS_WHERE}`,
    params,
  );
  return { rows, total: Number(total) };
}

/** One document, in the same shape, for a review to return. */
async function getDocument(uploadId) {
  const [rows] = await pool.query(
    `SELECT u.upload_id, u.owner_id AS driver_id, u.kind,
            u.review_status, u.review_notes, u.reviewed_by, u.reviewed_at,
            u.mime_type, u.size_bytes, u.original_name, u.uploaded_at,
            d.full_name AS driver_name,
            d.verification_status AS driver_verification_status
       FROM uploads u
       LEFT JOIN drivers d ON d.driver_id = u.owner_id
      WHERE u.upload_id = :uploadId AND u.owner_role = 'driver' AND u.deleted_at IS NULL
      LIMIT 1`,
    { uploadId },
  );
  return rows[0] || null;
}

// -----------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------

/**
 * Sets a driver's verification status, and records who decided it.
 *
 * The status is the column the phone app reads, so it stays the single
 * source of truth; the note and the reviewer go to the audit table beside
 * it, because `drivers` carries neither column in this repository's world.
 */
async function setDriverVerification(driverId, { decision, note, reviewedBy }) {
  const [result] = await pool.query(
    `UPDATE drivers SET verification_status = :decision
      WHERE driver_id = :driverId AND deleted_at IS NULL`,
    { decision, driverId },
  );
  if (result.affectedRows !== 1) return false;

  await pool.query(
    `INSERT INTO driver_verification_reviews (review_id, driver_id, decision, note, reviewed_by)
     VALUES (:reviewId, :driverId, :decision, :note, :reviewedBy)`,
    {
      reviewId: crypto.randomUUID(),
      driverId,
      decision,
      note: note ?? null,
      reviewedBy: reviewedBy ?? null,
    },
  );
  return true;
}

/** Records the decision on one document. */
async function setDocumentReview(uploadId, { status, notes, reviewedBy }) {
  const [result] = await pool.query(
    `UPDATE uploads
        SET review_status = :status,
            review_notes = :notes,
            reviewed_by = :reviewedBy,
            reviewed_at = NOW()
      WHERE upload_id = :uploadId AND owner_role = 'driver' AND deleted_at IS NULL`,
    { status, notes: notes ?? null, reviewedBy: reviewedBy ?? null, uploadId },
  );
  return result.affectedRows === 1;
}

/**
 * Suspends or restores an account, in the `status` column auth already reads.
 *
 * The role decides the table: rider -> customers.user_id, driver ->
 * drivers.driver_id. A suspension has to live here and nowhere else, because
 * this is the column login checks before it opens a session.
 */
async function setAccountStatus(role, accountId, status) {
  const cfg = getRoleConfig(role);
  if (!cfg) throw new Error(`Unknown role: ${role}`);
  const [result] = await pool.query(
    `UPDATE ${cfg.table} SET status = :status
      WHERE ${cfg.idColumn} = :accountId AND deleted_at IS NULL`,
    { status, accountId },
  );
  return result.affectedRows === 1;
}

/** The name and status of one account, for a write to return. */
async function getAccount(role, accountId) {
  const cfg = getRoleConfig(role);
  if (!cfg) throw new Error(`Unknown role: ${role}`);
  const [rows] = await pool.query(
    `SELECT ${cfg.idColumn} AS id, full_name, status
       FROM ${cfg.table}
      WHERE ${cfg.idColumn} = :accountId AND deleted_at IS NULL
      LIMIT 1`,
    { accountId },
  );
  return rows[0] || null;
}

/**
 * Registers a vehicle for a driver.
 *
 * Without this a driver can never receive offers: dispatch classifies a
 * driver by their vehicle, and until this console existed a vehicle could
 * be created only by hand in SQL. The plate is UNIQUE, so a duplicate throws
 * ER_DUP_ENTRY, which the service turns into a readable 409.
 */
async function createVehicle({ driverId, plateNumber, model, vehicleType, vehicleClass, color, verificationStatus }) {
  const vehicleId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO vehicles (vehicle_id, driver_id, plate_number, vehicle_model,
                           vehicle_type, vehicle_class, vehicle_color, verification_status)
     VALUES (:vehicleId, :driverId, :plateNumber, :model,
             :vehicleType, :vehicleClass, :color, :verificationStatus)`,
    {
      vehicleId,
      driverId,
      plateNumber,
      model: model ?? null,
      vehicleType: vehicleType ?? null,
      vehicleClass: vehicleClass ?? null,
      color: color ?? null,
      verificationStatus: verificationStatus || "pending",
    },
  );
  return vehicleId;
}

/** Updates only the vehicle columns present in `fields`. */
async function updateVehicle(vehicleId, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return false;
  const setClause = columns.map((col) => `${col} = :${col}`).join(", ");
  const [result] = await pool.query(
    `UPDATE vehicles SET ${setClause} WHERE vehicle_id = :vehicleId`,
    { ...fields, vehicleId },
  );
  return result.affectedRows === 1;
}

module.exports = {
  num,
  money,
  LIVE_STATUSES,
  overview,
  listRiders,
  listDrivers,
  getDriver,
  listTrips,
  getTrip,
  partiesOf,
  forceCancelTrip,
  listPayments,
  listDocuments,
  getDocument,
  setDriverVerification,
  setDocumentReview,
  setAccountStatus,
  getAccount,
  createVehicle,
  updateVehicle,
};
