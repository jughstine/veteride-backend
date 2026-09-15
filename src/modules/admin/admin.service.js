const AppError = require("../../utils/AppError");
const adminRepo = require("./repositories/admin.repository");
const userRepo = require("../auth/repositories/user.repository");
const vehicleRepo = require("../drivers/repositories/vehicle.repository");
const availabilityRepo = require("../drivers/repositories/availability.repository");
const vehicleClass = require("../drivers/vehicle-class");
const realtime = require("../../realtime/stream");

const { num, money } = adminRepo;

/** A page envelope, so every list answers the same shape. */
function page(rows, total, { limit, offset }) {
  return { page: { total, limit, offset } };
}

// -----------------------------------------------------------------------
// Views — DECIMAL to number, and never a hash, token or PIN
// -----------------------------------------------------------------------

function riderView(r) {
  return {
    user_id: r.user_id,
    full_name: r.full_name,
    email: r.email,
    phone_number: r.phone_number,
    status: r.status,
    total_trips: Number(r.total_trips || 0),
    wallet_balance: money(r.wallet_balance),
    is_verified: Boolean(r.is_verified),
    created_at: r.created_at,
  };
}

function driverVehicle(r) {
  if (!r.vehicle_id) return null;
  return {
    vehicle_id: r.vehicle_id,
    plate_number: r.plate_number,
    vehicle_model: r.vehicle_model,
    vehicle_type: r.vehicle_type,
    vehicle_class: r.vehicle_class,
    vehicle_color: r.vehicle_color,
    verification_status: r.vehicle_verification_status,
  };
}

function driverView(r) {
  return {
    driver_id: r.driver_id,
    full_name: r.full_name,
    email: r.email,
    phone_number: r.phone_number,
    status: r.status,
    verification_status: r.verification_status,
    availability_status: r.availability_status,
    license_number: r.license_number,
    // Derived from the rides, so NULL means "nobody has rated them", which is
    // a different thing from a zero.
    rating: num(r.rating),
    ratings: Number(r.ratings || 0),
    trips_completed: Number(r.trips_completed || 0),
    vehicle: driverVehicle(r),
  };
}

function tripListView(r) {
  return {
    trip_id: r.trip_id,
    status: r.status,
    pickup_address: r.pickup_address,
    dropoff_address: r.dropoff_address,
    distance_km: num(r.distance_km),
    estimated_fare: num(r.estimated_fare),
    final_fare: num(r.final_fare),
    vehicle_class: r.vehicle_class,
    service: r.service,
    payment_method: r.payment_method,
    requested_at: r.requested_at,
    matched_at: r.matched_at,
    pickup_at: r.pickup_at,
    dropoff_at: r.dropoff_at,
    updated_at: r.updated_at,
    rider_name: r.rider_name ?? null,
    driver_name: r.driver_name ?? null,
  };
}

/** The nested payment on a trip sheet, or null when no fare was recorded. */
function tripPayment(r) {
  if (!r.payment_id) return null;
  return {
    payment_id: r.payment_id,
    amount: num(r.payment_amount),
    payment_method: r.payment_method_used,
    status: r.payment_status,
    settled_with: r.settled_with,
    platform_fee: num(r.platform_fee),
    driver_earnings: num(r.driver_earnings),
    tip_amount: num(r.payment_tip),
    discount_amount: num(r.discount_amount),
    refund_amount: num(r.refund_amount),
    refund_reason: r.refund_reason,
    gateway_ref: r.payment_gateway_ref,
    paid_at: r.paid_at,
    created_at: r.payment_created_at,
  };
}

/** The rating on a trip sheet, or null on a ride nobody has rated. */
function tripRating(r) {
  if (r.rated_at === null || r.rated_at === undefined) return null;
  return {
    rating: num(r.rating),
    comment: r.rating_comment ?? null,
    tip_amount: num(r.tip_amount),
    rated_at: r.rated_at,
  };
}

function tripDetailView(r) {
  return {
    trip_id: r.trip_id,
    status: r.status,
    pickup_address: r.pickup_address,
    pickup_lat: num(r.pickup_lat),
    pickup_lng: num(r.pickup_lng),
    dropoff_address: r.dropoff_address,
    dropoff_lat: num(r.dropoff_lat),
    dropoff_lng: num(r.dropoff_lng),
    distance_km: num(r.distance_km),
    estimated_minutes: r.estimated_minutes,
    estimated_fare: num(r.estimated_fare),
    final_fare: num(r.final_fare),
    actual_duration_min: r.actual_duration_min,
    vehicle_class: r.vehicle_class,
    service: r.service,
    payment_method: r.payment_method,
    cancelled_by: r.cancelled_by ?? null,
    cancel_reason: r.cancel_reason ?? null,
    requested_at: r.requested_at,
    matched_at: r.matched_at,
    pickup_at: r.pickup_at,
    dropoff_at: r.dropoff_at,
    updated_at: r.updated_at,
    rider: r.rider_id
      ? { user_id: r.rider_id, full_name: r.rider_name, phone_number: r.rider_phone }
      : null,
    driver: r.driver_id
      ? { driver_id: r.driver_id, full_name: r.driver_name, phone_number: r.driver_phone }
      : null,
    vehicle: r.vehicle_id
      ? {
          vehicle_id: r.vehicle_id,
          plate_number: r.plate_number,
          vehicle_model: r.vehicle_model,
          vehicle_type: r.vehicle_type,
          vehicle_class: r.registered_vehicle_class,
        }
      : null,
    payment: tripPayment(r),
    rating: tripRating(r),
  };
}

function paymentView(r) {
  return {
    payment_id: r.payment_id,
    trip_id: r.trip_id,
    rider_id: r.rider_id,
    rider_name: r.rider_name ?? null,
    amount: num(r.amount),
    payment_method: r.payment_method,
    status: r.status,
    settled_with: r.settled_with,
    platform_fee: num(r.platform_fee),
    driver_earnings: num(r.driver_earnings),
    tip_amount: num(r.tip_amount),
    discount_amount: num(r.discount_amount),
    refund_amount: num(r.refund_amount),
    refund_reason: r.refund_reason,
    gateway_ref: r.payment_gateway_ref,
    paid_at: r.paid_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function documentView(r) {
  return {
    upload_id: r.upload_id,
    driver_id: r.driver_id,
    driver_name: r.driver_name ?? null,
    driver_verification_status: r.driver_verification_status ?? null,
    kind: r.kind,
    review_status: r.review_status,
    review_notes: r.review_notes ?? null,
    reviewed_by: r.reviewed_by ?? null,
    reviewed_at: r.reviewed_at ?? null,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes || 0),
    original_name: r.original_name ?? null,
    uploaded_at: r.uploaded_at,
    // The bytes are served by the uploads module, behind its own admin gate.
    url: `/uploads/${r.upload_id}/file`,
  };
}

// -----------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------

// GET /admin/overview
async function overview() {
  const raw = await adminRepo.overview();

  // Every state present and zero by default, so the console reads a full
  // object whether or not a status has any rows yet.
  const fold = (rows, keys) => {
    const out = Object.fromEntries(keys.map((k) => [k, 0]));
    for (const row of rows) if (row.k in out) out[row.k] = Number(row.n);
    return out;
  };

  return {
    riders: raw.riders,
    drivers: {
      total: raw.drivers,
      by_verification: fold(raw.driverVerification, [
        "pending",
        "approved",
        "rejected",
        "resubmission_required",
      ]),
      by_availability: fold(raw.driverAvailability, ["offline", "online", "on_trip"]),
    },
    trips: {
      live: fold(raw.liveTrips, adminRepo.LIVE_STATUSES),
      completed_today: raw.completedToday,
    },
    gross_today: raw.grossToday,
    documents_pending: raw.pendingDocuments,
  };
}

// GET /admin/riders
async function listRiders(query) {
  const { rows, total } = await adminRepo.listRiders(query);
  return { riders: rows.map(riderView), ...page(rows, total, query) };
}

// GET /admin/drivers
async function listDrivers(query) {
  const { rows, total } = await adminRepo.listDrivers(query);
  return { drivers: rows.map(driverView), ...page(rows, total, query) };
}

// GET /admin/trips
async function listTrips(query) {
  const { rows, total } = await adminRepo.listTrips(query);
  return { trips: rows.map(tripListView), ...page(rows, total, query) };
}

// GET /admin/trips/:tripId
async function getTrip(tripId) {
  const row = await adminRepo.getTrip(tripId);
  if (!row) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");
  return { trip: tripDetailView(row) };
}

// GET /admin/payments
async function listPayments(query) {
  const { rows, total } = await adminRepo.listPayments(query);
  return { payments: rows.map(paymentView), ...page(rows, total, query) };
}

// GET /admin/documents
async function listDocuments(query) {
  const { rows, total } = await adminRepo.listDocuments(query);
  return { documents: rows.map(documentView), ...page(rows, total, query) };
}

// -----------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------

// POST /admin/drivers/:driverId/verification
async function setDriverVerification(driverId, { decision, note }, adminId) {
  const ok = await adminRepo.setDriverVerification(driverId, {
    decision,
    note,
    reviewedBy: adminId,
  });
  if (!ok) throw new AppError(404, "DRIVER_NOT_FOUND", "No such driver");
  const driver = await adminRepo.getDriver(driverId);
  return { driver: driver ? driverView(driver) : null };
}

// POST /admin/documents/:uploadId/review
async function reviewDocument(uploadId, { status, notes }, adminId) {
  const ok = await adminRepo.setDocumentReview(uploadId, {
    status,
    notes,
    reviewedBy: adminId,
  });
  if (!ok) throw new AppError(404, "DOCUMENT_NOT_FOUND", "No such document");
  const doc = await adminRepo.getDocument(uploadId);
  return { document: doc ? documentView(doc) : null };
}

// POST /admin/accounts/:role/:accountId/status
async function setAccountStatus(role, accountId, status) {
  const ok = await adminRepo.setAccountStatus(role, accountId, status);
  if (!ok) throw new AppError(404, "ACCOUNT_NOT_FOUND", "No such account");
  const account = await adminRepo.getAccount(role, accountId);
  return { account: { role, ...account } };
}

/** The class dispatch will read, derived from whatever the operator typed. */
function normaliseClass(explicit, type) {
  const source = explicit ?? type;
  if (source === undefined || source === null) return undefined;
  // May be null — an unclassifiable vehicle is offered nothing and is told
  // why, which is a real state, not a failure to record.
  return vehicleClass.normalise(source);
}

// POST /admin/drivers/:driverId/vehicles
async function createVehicle(driverId, body) {
  const driver = await userRepo.findByIdForRole("driver", driverId);
  if (!driver) throw new AppError(404, "DRIVER_NOT_FOUND", "No such driver");

  let vehicleId;
  try {
    vehicleId = await adminRepo.createVehicle({
      driverId,
      plateNumber: body.plate_number,
      model: body.vehicle_model,
      vehicleType: body.vehicle_type,
      vehicleClass: normaliseClass(body.vehicle_class, body.vehicle_type) ?? null,
      color: body.vehicle_color,
      verificationStatus: body.verification_status,
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      throw new AppError(409, "PLATE_TAKEN", `${body.plate_number} is already registered`);
    }
    throw err;
  }

  const vehicle = await vehicleRepo.findById(vehicleId);
  return { vehicle };
}

// PATCH /admin/vehicles/:vehicleId
async function updateVehicle(vehicleId, body) {
  const existing = await vehicleRepo.findById(vehicleId);
  if (!existing) throw new AppError(404, "VEHICLE_NOT_FOUND", "No such vehicle");

  const fields = {};
  if (body.plate_number !== undefined) fields.plate_number = body.plate_number;
  if (body.vehicle_model !== undefined) fields.vehicle_model = body.vehicle_model;
  if (body.vehicle_color !== undefined) fields.vehicle_color = body.vehicle_color;
  if (body.verification_status !== undefined) fields.verification_status = body.verification_status;
  if (body.vehicle_type !== undefined) fields.vehicle_type = body.vehicle_type;
  // The class is re-derived whenever the type or an explicit class is sent,
  // so the stored class never drifts from the type it was read off.
  const klass = normaliseClass(body.vehicle_class, body.vehicle_type);
  if (klass !== undefined) fields.vehicle_class = klass;

  if (Object.keys(fields).length === 0) {
    throw new AppError(400, "NOTHING_TO_UPDATE", "No vehicle fields were given");
  }

  try {
    await adminRepo.updateVehicle(vehicleId, fields);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      throw new AppError(409, "PLATE_TAKEN", `${body.plate_number} is already registered`);
    }
    throw err;
  }

  const vehicle = await vehicleRepo.findById(vehicleId);
  return { vehicle };
}

// POST /admin/trips/:tripId/cancel
async function cancelTrip(tripId, reason) {
  const before = await adminRepo.partiesOf(tripId);
  if (!before) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");
  if (!adminRepo.LIVE_STATUSES.includes(before.status)) {
    throw new AppError(
      409,
      "NOT_LIVE",
      `A ${before.status} ride cannot be cancelled`,
    );
  }

  const cancelled = await adminRepo.forceCancelTrip(tripId, reason);
  if (!cancelled) {
    // The row changed out from under us — it finished or was cancelled first.
    const now = await adminRepo.getTrip(tripId);
    throw new AppError(409, "NOT_LIVE", "The ride is no longer live", {
      trip: now ? tripDetailView(now) : null,
    });
  }

  // The ride is over, so it stops holding its driver. Only a driver who was
  // 'on_trip' is freed — one who happened to be offline is left as they were.
  if (before.driver_id) {
    const status = await availabilityRepo.statusOf(before.driver_id);
    if (status === "on_trip") await availabilityRepo.set(before.driver_id, "offline");
  }

  realtime.notify([before.user_id, before.driver_id], "trip");
  realtime.notifyDrivers("offers");

  const row = await adminRepo.getTrip(tripId);
  return { trip: tripDetailView(row) };
}

module.exports = {
  overview,
  listRiders,
  listDrivers,
  listTrips,
  getTrip,
  listPayments,
  listDocuments,
  setDriverVerification,
  reviewDocument,
  setAccountStatus,
  createVehicle,
  updateVehicle,
  cancelTrip,
};
