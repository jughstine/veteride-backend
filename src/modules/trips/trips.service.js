const AppError = require("../../utils/AppError");
const env = require("../../config/env");
const tripRepo = require("./repositories/trip.repository");
const positionRepo = require("./repositories/position.repository");
const messageRepo = require("./repositories/message.repository");
const userRepo = require("../auth/repositories/user.repository");
const realtime = require("../../realtime/stream");

/**
 * Metres between two points, equirectangular.
 *
 * Plenty for "is this driver near that pickup": the error against the
 * haversine is under a metre at city scale, and it avoids a dependency for
 * one comparison.
 */
function metresBetween(lat1, lng1, lat2, lng2) {
  const metresPerDegree = 111_320;
  const dLat = (lat2 - lat1) * metresPerDegree;
  const dLng =
    (lng2 - lng1) * metresPerDegree * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** MySQL returns DECIMAL as a string; a coordinate must not reach the app as one. */
const num = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * One trip as both apps read it.
 *
 * `at_pickup` is computed here rather than stored: there is no status for
 * "the driver has arrived", it lasts about sixty seconds, and adding an
 * enum member would touch every switch in both clients.
 */
function toView(row, { driverPosition = null, driver = null } = {}) {
  const lat = num(driverPosition?.lat);
  const lng = num(driverPosition?.lng);
  const pickupLat = num(row.pickup_lat);
  const pickupLng = num(row.pickup_lng);

  const atPickup =
    row.status === "en_route_pickup" &&
    lat !== null &&
    lng !== null &&
    metresBetween(lat, lng, pickupLat, pickupLng) <= env.rides.atPickupMetres;

  return {
    trip_id: row.trip_id,
    status: row.status,
    pin: row.pin,

    pickup_address: row.pickup_address,
    pickup_lat: pickupLat,
    pickup_lng: pickupLng,
    dropoff_address: row.dropoff_address,
    dropoff_lat: num(row.dropoff_lat),
    dropoff_lng: num(row.dropoff_lng),

    distance_km: num(row.distance_km),
    estimated_minutes: row.estimated_minutes,
    estimated_fare: num(row.estimated_fare),
    final_fare: num(row.final_fare),

    rider_name: row.rider_name ?? null,
    driver: driver
      ? {
          name: driver.full_name,
          phone: driver.phone,
          rating: num(driver.rating),
        }
      : null,

    driver_lat: lat,
    driver_lng: lng,
    at_pickup: atPickup,

    cancelled_by: row.cancelled_by,
    cancel_reason: row.cancel_reason,

    requested_at: row.requested_at,
    matched_at: row.matched_at,
    pickup_at: row.pickup_at,
    dropoff_at: row.dropoff_at,
    updated_at: row.updated_at,
  };
}

/** Everything a trip view needs that is not on the trip row itself. */
async function decorate(row) {
  if (!row.driver_id) return toView(row);
  const [driver, position] = await Promise.all([
    userRepo.findByIdForRole("driver", row.driver_id),
    positionRepo.findByDriver(row.driver_id),
  ]);
  return toView(row, { driver, driverPosition: position });
}

// POST /trips — the passenger books.
async function book(userId, input) {
  // One live ride per passenger. Checked rather than assumed: without it a
  // double tap on a slow connection books two rides and sends two drivers.
  const existing = await tripRepo.findLiveForAccount(userId, "rider");
  if (existing) {
    throw new AppError(
      409,
      "RIDE_IN_PROGRESS",
      "You already have a ride in progress",
      { trip: await decorate(existing) },
    );
  }

  const row = await tripRepo.create({ userId, ...input });

  // Every driver holding a stream learns the open list moved. The event
  // carries no ride — their app re-reads GET /trips/open, which is where
  // the radius lives.
  realtime.notifyDrivers("offers");
  return decorate(row);
}

// GET /trips/mine — the ride this account is in the middle of, or null.
async function current(accountId, role) {
  const row = await tripRepo.findLiveForAccount(accountId, role);
  return row ? decorate(row) : null;
}

// GET /trips/:tripId — one ride, for a party to it.
async function readOne(tripId, accountId, role) {
  const row = await tripRepo.findByIdForParty(tripId, accountId, role);
  if (!row) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");
  return decorate(row);
}

// GET /trips/open — what an approved, online driver can take.
async function openRequests(driverId, { lat, lng }) {
  const driver = await userRepo.findByIdForRole("driver", driverId);
  if (!driver) throw new AppError(404, "PROFILE_NOT_FOUND", "Driver profile not found");
  if (driver.verification_status !== "approved") {
    throw new AppError(
      403,
      "NOT_VERIFIED",
      "Your documents are not approved yet",
    );
  }

  // Swept in the same request rather than on a schedule: the only thing
  // that needs stale rows gone is the query that would otherwise offer
  // them, so no cron and no background job.
  await tripRepo.sweepStale(env.rides.requestTtlMinutes);

  // The driver's position is posted, not passed in the query string, so a
  // handset cannot ask "what is available in Cebu" from Manila.
  await positionRepo.upsert(driverId, { lat, lng });

  const rows = await tripRepo.findOpenNear({
    lat,
    lng,
    radiusKm: env.rides.offerRadiusKm,
    ttlMinutes: env.rides.requestTtlMinutes,
  });

  return rows
    .map((row) => {
      const km =
        metresBetween(lat, lng, num(row.pickup_lat), num(row.pickup_lng)) / 1000;
      return { ...toView(row), rider_name: row.rider_name, distance_from_driver_km: Math.round(km * 100) / 100 };
    })
    // The box is square and the radius is a circle; this is the corner trim.
    .filter((offer) => offer.distance_from_driver_km <= env.rides.offerRadiusKm)
    .sort((a, b) => a.distance_from_driver_km - b.distance_from_driver_km);
}

// POST /trips/:tripId/accept — the driver takes it.
async function accept(tripId, driverId) {
  const driver = await userRepo.findByIdForRole("driver", driverId);
  if (!driver) throw new AppError(404, "PROFILE_NOT_FOUND", "Driver profile not found");
  if (driver.verification_status !== "approved") {
    throw new AppError(403, "NOT_VERIFIED", "Your documents are not approved yet");
  }

  const busy = await tripRepo.findLiveForAccount(driverId, "driver");
  if (busy) {
    throw new AppError(409, "RIDE_IN_PROGRESS", "You already have a ride in progress", {
      trip: await decorate(busy),
    });
  }

  const row = await tripRepo.findById(tripId);
  if (!row) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");

  const won = await tripRepo.claim(tripId, driverId);
  if (!won) {
    // The UPDATE matched nothing, so somebody else changed this row first.
    // Re-read to say which of the two it was.
    const now = await tripRepo.findById(tripId);
    if (now?.status === "cancelled") {
      throw new AppError(409, "TRIP_CANCELLED", "The passenger cancelled this ride");
    }
    throw new AppError(409, "TRIP_TAKEN", "Another driver took this ride");
  }

  const claimed = await tripRepo.findById(tripId);
  const parties = await tripRepo.partiesOf(tripId);
  realtime.notify([parties?.user_id, parties?.driver_id], "trip");
  // And it leaves every other driver's open list.
  realtime.notifyDrivers("offers");
  return decorate(claimed);
}

/** Who may move a ride from where to where. The whole lifecycle, in one place. */
const TRANSITIONS = {
  en_route_pickup: { from: ["matched"], role: "driver" },
  in_progress: { from: ["matched", "en_route_pickup"], role: "driver" },
  completed: { from: ["in_progress"], role: "driver" },
  cancelled: {
    from: ["requested", "matched", "en_route_pickup"],
    role: "either",
  },
};

// POST /trips/:tripId/status — one transition.
async function advance(tripId, { accountId, role, to, pin, reason }) {
  const rule = TRANSITIONS[to];
  if (!rule) throw new AppError(400, "UNKNOWN_STATUS", "Unknown status");

  const row = await tripRepo.findByIdForParty(tripId, accountId, role);
  if (!row) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");

  if (rule.role !== "either" && rule.role !== role) {
    throw new AppError(403, "FORBIDDEN", "Only the driver can do that");
  }
  if (!rule.from.includes(row.status)) {
    throw new AppError(409, "BAD_TRANSITION", `A ${row.status} ride cannot become ${to}`, {
      trip: await decorate(row),
    });
  }

  // Starting the ride is the PIN handover, and the server is what compares
  // it — over a keypad the passenger's phone never saw the answer to.
  if (to === "in_progress") {
    if (!row.pin) {
      throw new AppError(409, "NO_PIN", "This ride has no PIN and cannot be started");
    }
    if (String(pin ?? "").trim() !== row.pin) {
      throw new AppError(409, "WRONG_PIN", "That PIN is not right");
    }
  }

  const moved = await tripRepo.advance(tripId, {
    from: rule.from,
    to,
    extra: {
      cancelledBy: to === "cancelled" ? (role === "driver" ? "driver" : "rider") : null,
      cancelReason: to === "cancelled" ? (reason ?? "Cancelled") : null,
    },
  });
  if (!moved) {
    throw new AppError(409, "BAD_TRANSITION", "This ride moved on already", {
      trip: await decorate(await tripRepo.findById(tripId)),
    });
  }

  const parties = await tripRepo.partiesOf(tripId);
  realtime.notify([parties?.user_id, parties?.driver_id], "trip");
  // A cancelled ride rejoins nobody's list; a completed one frees its driver.
  if (to === "cancelled" || to === "completed") realtime.notifyDrivers("offers");

  return decorate(await tripRepo.findById(tripId));
}

// POST /drivers/me/position — where this driver is now.
async function postPosition(driverId, { lat, lng, heading, accuracyM }) {
  // A fix that could be a block away is refused rather than written.
  if (accuracyM != null && accuracyM > 100) {
    throw new AppError(400, "FIX_TOO_COARSE", "That fix is not accurate enough to use");
  }
  await positionRepo.upsert(driverId, { lat, lng, heading, accuracyM });

  // A moving driver is what the passenger's map follows, so their phone is
  // told rather than left to poll for it.
  const live = await tripRepo.findLiveForAccount(driverId, "driver");
  if (live) realtime.notify([live.user_id], "trip");
}

// GET /trips/:tripId/messages
async function readMessages(tripId, accountId, role) {
  const row = await tripRepo.findByIdForParty(tripId, accountId, role);
  if (!row) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");
  return messageRepo.listForTrip(tripId);
}

// POST /trips/:tripId/messages
async function postMessage(tripId, { accountId, role, body }) {
  const row = await tripRepo.findByIdForParty(tripId, accountId, role);
  if (!row) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");
  // A thread that outlives its ride is a way to reach a stranger you shared
  // a car with last week.
  if (row.status === "completed" || row.status === "cancelled") {
    throw new AppError(409, "RIDE_OVER", "This ride is over");
  }

  const message = await messageRepo.create(tripId, {
    senderId: accountId,
    senderRole: role === "driver" ? "driver" : "rider",
    body,
  });

  realtime.notify([row.user_id, row.driver_id], "chat");
  return message;
}

module.exports = {
  book,
  current,
  readOne,
  openRequests,
  accept,
  advance,
  postPosition,
  readMessages,
  postMessage,
};
