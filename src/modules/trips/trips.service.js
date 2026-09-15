const crypto = require("crypto");
const AppError = require("../../utils/AppError");
const env = require("../../config/env");
const tripRepo = require("./repositories/trip.repository");
const positionRepo = require("./repositories/position.repository");
const messageRepo = require("./repositories/message.repository");
const userRepo = require("../auth/repositories/user.repository");
const availabilityRepo = require("../drivers/repositories/availability.repository");
const vehicleRepo = require("../drivers/repositories/vehicle.repository");
const vehicleClass = require("../drivers/vehicle-class");
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
    // The same figure under the name both apps read it by. Sent alongside
    // the older key rather than instead of it, so nothing that is already
    // reading `estimated_minutes` breaks on the day this ships.
    estimated_duration_min: row.estimated_minutes,
    estimated_fare: num(row.estimated_fare),
    final_fare: num(row.final_fare),
    actual_duration_min: row.actual_duration_min,

    // What was booked, and what for. Both sides of the ride read these: the
    // passenger's screen says which vehicle is coming, and the driver's
    // card says whether they are collecting a person or a parcel.
    vehicle_class: row.vehicle_class,
    service: row.service,

    rider_name: row.rider_name ?? null,
    driver: driver
      ? {
          name: driver.full_name,
          // The column is `phone_number`; `driver.phone` was undefined, so
          // the key vanished from the JSON entirely and the passenger's
          // driver card had no number to call.
          phone: driver.phone_number ?? null,
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

/**
 * One open request, as the driver's card reads it.
 *
 * Built field by field rather than from toView(), and that is the point:
 * toView() includes the PIN, and spreading it here published the handover
 * code of every open booking in the city to every approved driver near it —
 * who could then meet the passenger and start a ride they never accepted.
 * A driver learns the PIN after they have won the trip and not before.
 */
function toOffer(row, { lat, lng }) {
  const pickupLat = num(row.pickup_lat);
  const pickupLng = num(row.pickup_lng);
  const km = metresBetween(lat, lng, pickupLat, pickupLng) / 1000;

  return {
    trip_id: row.trip_id,
    rider: row.rider_name ?? "Passenger",
    // There is no rider rating in this schema — nothing rates a passenger.
    // The key is present so the driver's app never has to ask whether it
    // exists; a number here would be one this server made up.
    rider_rating: null,

    pickup_address: row.pickup_address,
    pickup_lat: pickupLat,
    pickup_lng: pickupLng,
    dropoff_address: row.dropoff_address,
    dropoff_lat: num(row.dropoff_lat),
    dropoff_lng: num(row.dropoff_lng),

    distance_km: num(row.distance_km),
    estimated_fare: num(row.estimated_fare),
    estimated_duration_min: row.estimated_minutes,

    vehicle_class: row.vehicle_class,
    service: row.service,

    distance_from_driver_km: Math.round(km * 100) / 100,
    requested_at: row.requested_at,
    // From the database's clock. Defaulting to 0 in the app means a missing
    // one reads as "just booked" for ever, however long they have waited.
    age_seconds: Number(row.age_seconds) || 0,
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

/**
 * 'ride' or 'parcel', out of whatever word the client uses for it.
 *
 * The app's ServiceKey names are `moto`, `car`, `send` and `resv`; only one
 * of them is a parcel. Anything unrecognised is a ride, which is the
 * default the contract states and the only one of the two that is about a
 * person — a parcel misfiled as a ride is a card with the wrong word on it,
 * where a person misfiled as a parcel is a passenger nobody came for.
 */
const SERVICES = {
  ride: "ride",
  moto: "ride",
  car: "ride",
  truck6: "ride",
  resv: "ride",
  parcel: "parcel",
  send: "parcel",
  delivery: "parcel",
};

/**
 * What this booking is for: one class and one service.
 *
 * A class that was named and cannot be read is a 400, never a default. The
 * passenger picked a vehicle on a screen that quoted them a fare for it;
 * turning "6-wheeler" into a motorcycle because the spelling was new is the
 * one outcome nobody involved can act on.
 */
function classify({ vehicleClass: asked, service }) {
  const chosen = SERVICES[String(service ?? "").trim().toLowerCase()] || "ride";
  const named = String(asked ?? "").trim();

  if (named) {
    const klass = vehicleClass.normalise(named);
    if (!klass) {
      throw new AppError(
        400,
        "UNKNOWN_VEHICLE_CLASS",
        `"${named}" is not a vehicle class this service books`,
      );
    }
    return { vehicleClass: klass, service: chosen };
  }

  // No class named at all. Two of the app's older service words are the
  // names of vehicles, so they are read as one before the default applies;
  // anything else is a motorcycle, which is what every ride booked before
  // this existed was.
  return {
    vehicleClass: vehicleClass.normalise(service) || "motorcycle",
    service: chosen,
  };
}

// POST /trips — the passenger books.
async function book(userId, input) {
  // Read before anything is written, so a booking for a vehicle nobody
  // runs is refused without having gone looking for a live ride first.
  const booked = classify(input);

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

  const row = await tripRepo.create({ userId, ...input, ...booked });

  // Every driver holding a stream learns the open list moved. The event
  // carries no ride — their app re-reads GET /trips/open, which is where
  // the radius and the class filter live. Still a broadcast, so a driver on
  // the wrong vehicle is woken for work they will not be shown; filtering
  // here would put the class rule in two places, which is how the two stop
  // agreeing.
  realtime.notifyDrivers("offers");
  return decorate(row);
}

/**
 * Gives a driver back to the pool at the end of a ride.
 *
 * Not simply 'online': a driver whose documents were rejected while they
 * were driving must land on 'offline', because the one thing availability
 * promises is that an approved driver is behind every online row. They can
 * always finish or cancel the ride they are inside — the trip row is the
 * only authority on whether one is running, and nothing reads availability
 * to decide that.
 */
async function freeDriver(driverId) {
  if (!driverId) return;
  const driver = await userRepo.findByIdForRole("driver", driverId);
  await availabilityRepo.set(
    driverId,
    driver?.verification_status === "approved" ? "online" : "offline",
  );
}

/**
 * Ends what stopped happening, and frees whoever was stranded by it.
 *
 * Lazy, and called from the reads that would otherwise trip over the rows
 * it removes: there is no cron and no background job in this process, so a
 * sweep that lived in one would be a second deployment artefact to keep
 * running. The two ends of it are a request nobody accepted and a ride
 * nobody finished.
 */
async function sweep() {
  await tripRepo.sweepStale(env.rides.requestTtlMinutes);
  const stranded = await tripRepo.sweepAbandoned(env.rides.liveTripMaxHours);
  for (const driverId of stranded) await freeDriver(driverId);
  return stranded;
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
  await sweep();

  // The driver's position is posted, not passed in the query string, so a
  // handset cannot ask "what is available in Cebu" from Manila.
  await positionRepo.upsert(driverId, { lat, lng });

  // What this driver can carry decides what they are shown. A booking names
  // one class and one class only: "if they book for example in motorcycle
  // only driver with motorcycle will see".
  const vehicle = await vehicleRepo.findForDriver(driverId);
  const klass = vehicleClass.classOfVehicle(vehicle);
  if (!klass) {
    // An empty list with a reason, not an empty list. A driver with no
    // vehicle on file — or one typed in as something nobody can classify —
    // will never be offered anything, and a dashboard that says only
    // "no requests near you" leaves them waiting for work that cannot
    // arrive. `reason` is the sentence their app can act on.
    return { requests: [], reason: "no vehicle class" };
  }

  const rows = await tripRepo.findOpenNear({
    lat,
    lng,
    radiusKm: env.rides.offerRadiusKm,
    ttlMinutes: env.rides.requestTtlMinutes,
    vehicleClass: klass,
  });

  const requests = rows
    .map((row) => toOffer(row, { lat, lng }))
    // The box is square and the radius is a circle; this is the corner trim.
    .filter((offer) => offer.distance_from_driver_km <= env.rides.offerRadiusKm)
    .sort((a, b) => a.distance_from_driver_km - b.distance_from_driver_km);

  // The key is always present, so the driver's app reads one shape whether
  // the silence has a reason behind it or not.
  return { requests, reason: null };
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

  // The same rule as the open list, applied again at the tap. The list is
  // a snapshot and this is the commitment: a driver who kept a screen open
  // while the console changed their vehicle must not take work their new
  // vehicle cannot do.
  const vehicle = await vehicleRepo.findForDriver(driverId);
  const klass = vehicleClass.classOfVehicle(vehicle);
  if (!klass) {
    throw new AppError(
      403,
      "NO_VEHICLE_CLASS",
      "Your vehicle has no type on file, so you cannot be matched to a booking",
    );
  }
  if (klass !== row.vehicle_class) {
    // The refusal names the class and carries nothing else. This driver is
    // not a party to that ride and never will be, and the trip view has the
    // handover PIN in it.
    throw new AppError(
      409,
      "VEHICLE_CLASS_MISMATCH",
      `This ride needs a ${vehicleClass.labelOf(row.vehicle_class)}`,
    );
  }

  const won = await tripRepo.claim(tripId, driverId, {
    vehicleId: vehicle.vehicle_id,
    vehicleClass: klass,
  });
  if (!won) {
    // The UPDATE matched nothing, so somebody else changed this row first.
    // Re-read to say which of the two it was.
    const now = await tripRepo.findById(tripId);
    if (now?.status === "cancelled") {
      throw new AppError(409, "TRIP_CANCELLED", "The passenger cancelled this ride");
    }
    throw new AppError(409, "TRIP_TAKEN", "Another driver took this ride");
  }

  // Availability now belongs to the ride. Written after the claim rather
  // than before it, so a driver who lost the race is not marked busy by
  // having tried.
  await availabilityRepo.set(driverId, "on_trip");

  const claimed = await tripRepo.findById(tripId);
  const parties = await tripRepo.partiesOf(tripId);
  realtime.notify([parties?.user_id, parties?.driver_id], "trip");
  // And it leaves every other driver's open list.
  realtime.notifyDrivers("offers");
  return decorate(claimed);
}

/**
 * Who may move a ride from where to where. The whole lifecycle, in one place.
 *
 * Keyed by role rather than carrying one, because cancellation is not the
 * same right on both sides. A passenger may call it off up to the moment
 * they get in; a driver may also end a ride that has already started —
 * a passenger who never boarded, an address that does not exist — and
 * without that a driver inside a running ride can only escape it by
 * declaring they completed a journey that did not happen.
 *
 * in_progress is reachable from en_route_pickup ALONE. Starting a ride
 * without ever having declared you were on the way skips the arrival the
 * passenger's map is watching for, and hands the PIN keypad to a driver
 * whose phone never said where they were.
 */
const TRANSITIONS = {
  en_route_pickup: { from: { driver: ["matched"] } },
  in_progress: { from: { driver: ["en_route_pickup"] } },
  completed: { from: { driver: ["in_progress"] } },
  cancelled: {
    from: {
      rider: ["requested", "matched", "en_route_pickup"],
      driver: ["matched", "en_route_pickup", "in_progress"],
    },
  },
};

/**
 * Constant-time compare of two PINs, the way a digest is compared.
 *
 * Five attempts is the real defence; this costs nothing and removes the
 * question of what a reply's timing gives away about how many digits were
 * right.
 */
function samePin(typed, stored) {
  const a = Buffer.from(String(typed ?? "").trim(), "utf8");
  const b = Buffer.from(String(stored ?? "").trim(), "utf8");
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /trips/:tripId/status — one transition.
async function advance(tripId, { accountId, role, to, pin, reason }) {
  const rule = TRANSITIONS[to];
  if (!rule) throw new AppError(400, "UNKNOWN_STATUS", "Unknown status");

  const row = await tripRepo.findByIdForParty(tripId, accountId, role);
  if (!row) throw new AppError(404, "TRIP_NOT_FOUND", "No such trip");

  const allowedFrom = rule.from[role];
  if (!allowedFrom) {
    throw new AppError(403, "FORBIDDEN", "Only the driver can do that");
  }
  if (!allowedFrom.includes(row.status)) {
    throw new AppError(409, "BAD_TRANSITION", `A ${row.status} ride cannot become ${to}`, {
      trip: await decorate(row),
    });
  }

  // A cancellation nobody can explain is exactly what the
  // trips_cancelled_by_present CHECK exists to prevent, and a substituted
  // "Cancelled" is that row with a word in the column. The passenger's app
  // has always sent one; a client that does not is refused rather than
  // quietly recorded.
  const cancelReason = String(reason ?? "").trim();
  if (to === "cancelled" && !cancelReason) {
    throw new AppError(400, "REASON_REQUIRED", "A reason is required to cancel");
  }

  // Starting the ride is the PIN handover, and the server is what compares
  // it — over a keypad the passenger's phone never saw the answer to.
  if (to === "in_progress") {
    if (!row.pin) {
      throw new AppError(409, "NO_PIN", "This ride has no PIN and cannot be started");
    }
    // Four digits is ten thousand guesses, and a keypad can send them far
    // faster than a passenger can read one out. The count is per trip, so
    // a fresh ride is a fresh five, and it is reset on arrival at the
    // pickup — where the passenger is standing in front of the driver and
    // can simply say the number again.
    const limit = env.rides.pinAttempts;
    if (Number(row.pin_attempts) >= limit) {
      throw new AppError(
        409,
        "PIN_LOCKED",
        `Too many wrong PINs. Ask the passenger to read it out again, or cancel the ride.`,
        { attempts_left: 0 },
      );
    }
    if (!samePin(pin, row.pin)) {
      const used = await tripRepo.registerPinFailure(tripId, limit);
      const left = Math.max(0, limit - used);
      throw new AppError(
        409,
        left === 0 ? "PIN_LOCKED" : "WRONG_PIN",
        left === 0
          ? "Too many wrong PINs. Ask the passenger to read it out again, or cancel the ride."
          : "That PIN is not right",
        { attempts_left: left },
      );
    }
  }

  const moved = await tripRepo.advance(tripId, {
    from: allowedFrom,
    to,
    extra: {
      cancelledBy: to === "cancelled" ? (role === "driver" ? "driver" : "rider") : null,
      cancelReason: to === "cancelled" ? cancelReason : null,
    },
  });
  if (!moved) {
    throw new AppError(409, "BAD_TRANSITION", "This ride moved on already", {
      trip: await decorate(await tripRepo.findById(tripId)),
    });
  }

  const parties = await tripRepo.partiesOf(tripId);

  // The ride is over, so it stops holding its driver. Both endings free
  // them — a passenger who cancels while the driver is on the way has to
  // give that driver back to the pool, or the next booking is offered to
  // one fewer person for ever.
  if (to === "cancelled" || to === "completed") await freeDriver(parties?.driver_id);

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
  sweep,
};
