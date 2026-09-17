const crypto = require("crypto");
const pool = require("../../../config/db");

/** Columns every read of a trip returns, so the shapes never drift apart. */
const TRIP_COLUMNS = `
  t.trip_id, t.user_id, t.driver_id, t.status,
  t.pickup_address, t.pickup_lat, t.pickup_lng,
  t.dropoff_address, t.dropoff_lat, t.dropoff_lng,
  t.distance_km, t.estimated_minutes, t.estimated_fare, t.final_fare,
  t.actual_duration_min,
  t.vehicle_class, t.service, t.vehicle_id,
  t.payment_method,
  t.rating, t.rating_comment, t.tip_amount, t.rated_at,
  t.pin, t.pin_attempts, t.pin_locked_at,
  t.cancelled_by, t.cancel_reason,
  t.requested_at, t.matched_at, t.pickup_at, t.dropoff_at, t.updated_at`;

/** The states a ride is still happening in. */
const LIVE_STATUSES = ["requested", "matched", "en_route_pickup", "in_progress"];

/**
 * A four-digit PIN from crypto, not Math.random.
 *
 * Generated here rather than on a handset: a PIN the passenger's phone
 * invents is a number only that phone knows, so the driver's keypad would
 * have nothing to check it against.
 */
function newPin() {
  return String(crypto.randomInt(0, 10000)).padStart(4, "0");
}

async function create({
  userId,
  pickupAddress, pickupLat, pickupLng,
  dropoffAddress, dropoffLat, dropoffLng,
  distanceKm, estimatedMinutes, estimatedFare,
  vehicleClass, service, paymentMethod,
}) {
  const tripId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO trips (
       trip_id, user_id, status,
       pickup_address, pickup_lat, pickup_lng,
       dropoff_address, dropoff_lat, dropoff_lng,
       distance_km, estimated_minutes, estimated_fare,
       vehicle_class, service, payment_method, pin
     ) VALUES (
       :tripId, :userId, 'requested',
       :pickupAddress, :pickupLat, :pickupLng,
       :dropoffAddress, :dropoffLat, :dropoffLng,
       :distanceKm, :estimatedMinutes, :estimatedFare,
       :vehicleClass, :service, :paymentMethod, :pin
     )`,
    {
      tripId, userId,
      pickupAddress, pickupLat, pickupLng,
      dropoffAddress, dropoffLat, dropoffLng,
      distanceKm: distanceKm ?? null,
      estimatedMinutes: estimatedMinutes ?? null,
      estimatedFare: estimatedFare ?? null,
      // The column defaults cover a row written by anything older than this
      // file; a booking that reached here has already been normalised.
      vehicleClass: vehicleClass || "motorcycle",
      service: service || "ride",
      // Cash is the default the column carries, and it is the honest one:
      // with no gateway anywhere in this API, a fare nobody named a method
      // for is a fare handed to the driver.
      paymentMethod: paymentMethod || "cash",
      pin: newPin(),
    },
  );
  return findById(tripId);
}

async function findById(tripId) {
  const [rows] = await pool.query(
    `SELECT ${TRIP_COLUMNS} FROM trips t WHERE t.trip_id = :tripId LIMIT 1`,
    { tripId },
  );
  return rows[0] || null;
}

/**
 * The column an account's id lives in, for its role.
 *
 * This exists because ids are NOT globally unique. `customers.user_id` and
 * `drivers.driver_id` are separate AUTO_INCREMENT sequences, so customer 1
 * and driver 1 are different people who happen to share a number. Asking
 * `user_id = :id OR driver_id = :id` therefore hands a driver the
 * passenger's ride the moment those two numbers line up — which they do
 * immediately on a fresh database.
 */
function columnForRole(role) {
  if (role === "driver") return "driver_id";
  if (role === "rider") return "user_id";
  throw new Error(`Rides do not belong to the role "${role}"`);
}

/** The trip only if this account is a party to it — callers use this to enforce access. */
async function findByIdForParty(tripId, accountId, role) {
  const column = columnForRole(role);
  const [rows] = await pool.query(
    `SELECT ${TRIP_COLUMNS} FROM trips t
      WHERE t.trip_id = :tripId AND t.${column} = :accountId
      LIMIT 1`,
    { tripId, accountId },
  );
  return rows[0] || null;
}

/** The ride this account is in the middle of, on its own side of it. */
async function findLiveForAccount(accountId, role) {
  const column = columnForRole(role);
  const [rows] = await pool.query(
    `SELECT ${TRIP_COLUMNS} FROM trips t
      WHERE t.${column} = :accountId
        AND t.status IN ('requested','matched','en_route_pickup','in_progress')
      ORDER BY t.requested_at DESC
      LIMIT 1`,
    { accountId },
  );
  return rows[0] || null;
}

/**
 * Unclaimed rides near a driver, of the one class they can carry.
 *
 * A bounding box in SQL and the exact distance in JS: MySQL has no spatial
 * index on plain DECIMAL columns, so the box is what `trips_open_idx`
 * can actually serve. One degree of latitude is ~111 km and a degree of
 * longitude is shorter than that everywhere off the equator, so the box is
 * generous in both directions and the precise filter below narrows it.
 *
 * `vehicleClass` is not optional and has no default. A booking for a car is
 * work a motorcycle cannot do, and the whole of that rule lives in this one
 * equality — a caller that could omit it is a caller that can offer a
 * six-wheeler load to a scooter by forgetting an argument.
 *
 * `age_seconds` comes from the database's clock, not from the reader's: the
 * driver's card says how long the passenger has been waiting, and two
 * machines' idea of "now" differ by more than that card's precision.
 *
 * `driverId` and `cooloffMinutes` are what makes a booking MOVE ON. A
 * request stays 'requested' and is offered to every nearby driver of the
 * class until somebody wins the accept — which is right — but without the
 * NOT EXISTS below the driver who just let their card lapse is handed the
 * very same row on their next poll, two seconds later, for ever, while the
 * passenger's wait looks the same as if nobody had ever seen it. The
 * subquery hides it from THAT ONE DRIVER for the cool-off and from nobody
 * else; the row is untouched, so this is a read-side rotation and not a
 * state change.
 *
 * It is a window and not a blacklist: the comparison is against
 * `declined_at`, so the booking returns to that driver once their window
 * lapses. A ride every driver in range has passed on therefore comes back
 * rather than vanishing, and one nobody ever takes still ends where it
 * always did — at the request TTL, in sweepStale().
 *
 * Both arguments are required for the same reason `vehicleClass` is: a
 * caller that could omit `driverId` is a caller that silently shows a
 * driver the bookings they have already refused by forgetting an argument.
 */
async function findOpenNear({
  lat, lng, radiusKm, ttlMinutes, vehicleClass, driverId, cooloffMinutes, limit = 10,
}) {
  const degrees = radiusKm / 111.0;
  const [rows] = await pool.query(
    `SELECT ${TRIP_COLUMNS}, c.full_name AS rider_name,
            TIMESTAMPDIFF(SECOND, t.requested_at, NOW()) AS age_seconds
       FROM trips t
       JOIN customers c ON c.user_id = t.user_id
      WHERE t.status = 'requested'
        AND t.driver_id IS NULL
        AND t.vehicle_class = :vehicleClass
        AND t.requested_at > (NOW() - INTERVAL :ttlMinutes MINUTE)
        AND t.pickup_lat BETWEEN :south AND :north
        AND t.pickup_lng BETWEEN :west  AND :east
        AND NOT EXISTS (
              SELECT 1 FROM trip_declines d
               WHERE d.trip_id = t.trip_id
                 AND d.driver_id = :driverId
                 AND d.declined_at > (NOW() - INTERVAL :cooloffMinutes MINUTE))
      ORDER BY t.requested_at ASC
      LIMIT :limit`,
    {
      vehicleClass,
      ttlMinutes,
      driverId,
      cooloffMinutes,
      south: lat - degrees,
      north: lat + degrees,
      west: lng - degrees,
      east: lng + degrees,
      limit,
    },
  );
  return rows;
}

/**
 * Records that one driver passed on one booking.
 *
 * INSERT ... ON DUPLICATE KEY UPDATE, so the route is idempotent by the
 * primary key rather than by a read-then-write the caller would have to get
 * right: a double tap, a retry over a flaky tunnel, or a 30-second lapse
 * landing just after the Decline button all write the same (trip, driver)
 * and the second one is not an error.
 *
 * The timestamp is REFRESHED by that second write, on purpose. The cool-off
 * belongs to the last time this driver said no, not the first: a driver
 * offered the booking again after their window lapsed, who passes on it
 * again, has said the same thing twice and gets the same quiet for it.
 *
 * Nothing here reads or writes `trips`. A decline is not a cancellation and
 * must never become one — the row stays 'requested' and open to everybody
 * else, and the only thing that ends a request nobody takes is sweepStale().
 */
async function recordDecline(tripId, driverId) {
  await pool.query(
    `INSERT INTO trip_declines (trip_id, driver_id, declined_at)
          VALUES (:tripId, :driverId, NOW())
     ON DUPLICATE KEY UPDATE declined_at = NOW()`,
    { tripId, driverId },
  );
}

/** When this driver last passed on this booking, or null. Used by tests and support. */
async function findDecline(tripId, driverId) {
  const [rows] = await pool.query(
    `SELECT declined_at FROM trip_declines
      WHERE trip_id = :tripId AND driver_id = :driverId LIMIT 1`,
    { tripId, driverId },
  );
  return rows[0] || null;
}

/**
 * Takes an unclaimed ride for this driver.
 *
 * The WHERE clause is the whole lock. Two drivers tapping Accept in the
 * same second both run this UPDATE; the one that commits first leaves
 * `driver_id IS NULL` false, so the second matches zero rows and is told
 * it lost. Reading the row first and updating after would let both pass
 * the read before either wrote.
 *
 * `vehicle_class` is in the WHERE as well, and not because it can change —
 * it is written once at booking and never again. It is there so that no
 * future caller can take a ride for a vehicle that cannot carry it by
 * forgetting the check; the readable refusal is raised in the service,
 * before this runs, so a driver reads a sentence rather than losing a race
 * they were never in.
 *
 * The PIN counter is reset here rather than left alone: a driver who wins a
 * trip starts with all their attempts, whatever the last driver on this row
 * did with theirs.
 */
async function claim(tripId, driverId, { vehicleId = null, vehicleClass } = {}) {
  const [result] = await pool.query(
    `UPDATE trips
        SET driver_id = :driverId,
            vehicle_id = :vehicleId,
            status    = 'matched',
            matched_at = NOW(),
            pin_attempts = 0,
            pin_locked_at = NULL
      WHERE trip_id = :tripId
        AND driver_id IS NULL
        AND status = 'requested'
        AND vehicle_class = :vehicleClass`,
    { tripId, driverId, vehicleId, vehicleClass },
  );
  return result.affectedRows === 1;
}

/**
 * Moves a ride to its next state.
 *
 * `from` is not decoration: passing the state the caller believes the ride
 * is in makes this refuse a transition computed from a stale screen.
 */
async function advance(tripId, { from, to, extra = {} }) {
  const stamps = {
    // Arriving at the pickup gives the PIN counter back. The passenger is
    // now in front of the driver and can read the number out; a lock earned
    // from guessing at it on the way there must not outlive the drive.
    en_route_pickup: ", pin_attempts = 0, pin_locked_at = NULL",
    in_progress: ", pickup_at = NOW()",
    // How long it really took, stamped once. TIMESTAMPDIFF over pickup_at
    // rather than requested_at: the ride is the part the passenger was in
    // the vehicle for, and the wait for a driver is a different number.
    // GREATEST(1, …) because a ride that took forty seconds took a minute;
    // a receipt for zero minutes reads as a ride that never happened.
    //
    // The fare is the estimate and nothing else. estimated_fare is this
    // server's own figure — modules/trips/fares.js priced it at booking
    // from the tariff and the route, and no client number reaches this
    // column — so copying it here is the agreed price becoming the charged
    // one. The trailing 0 is for a row written before any of that existed:
    // a completed ride with no fare at all cannot be receipted.
    completed:
      ", dropoff_at = NOW()" +
      ", final_fare = COALESCE(final_fare, estimated_fare, 0)" +
      ", actual_duration_min = COALESCE(actual_duration_min," +
      " GREATEST(1, TIMESTAMPDIFF(MINUTE, pickup_at, NOW())))",
    cancelled: ", cancelled_by = :cancelledBy, cancel_reason = :cancelReason",
  };

  const [result] = await pool.query(
    `UPDATE trips
        SET status = :to ${stamps[to] || ""}
      WHERE trip_id = :tripId
        AND status IN (:from)`,
    {
      tripId,
      to,
      from,
      cancelledBy: extra.cancelledBy ?? null,
      cancelReason: extra.cancelReason ?? null,
    },
  );
  return result.affectedRows === 1;
}

/**
 * Writes the passenger's verdict on their own finished ride, once.
 *
 * The WHERE clause is the whole rule, exactly as claim() is for an accept:
 * the ride must be this passenger's, it must be over, and it must not have
 * been rated already. Two taps on a slow connection both run this; the
 * first leaves `rated_at IS NULL` false, so the second matches no rows and
 * is told the ride is already rated rather than overwriting a verdict —
 * or, worse, paying a second tip.
 *
 * `role` is not a parameter and must not become one. A rating is the
 * passenger's, so this scopes on user_id: asking `user_id = :id OR
 * driver_id = :id` would let driver 1 rate customer 1's ride the moment
 * those two sequences lined up, which on a fresh database is immediately.
 */
async function rate(tripId, userId, { rating, comment = null, tip = 0 }) {
  const [result] = await pool.query(
    `UPDATE trips
        SET rating = :rating,
            rating_comment = :comment,
            tip_amount = :tip,
            rated_at = NOW()
      WHERE trip_id = :tripId
        AND user_id = :userId
        AND status = 'completed'
        AND rated_at IS NULL`,
    { tripId, userId, rating, comment, tip },
  );
  return result.affectedRows === 1;
}

/**
 * A driver's rating: the average of what their own passengers gave them.
 *
 * Derived rather than stored. A column somebody has to remember to update
 * is a column that disagrees with the rides it claims to summarise, and
 * `drivers` is a table this repository is not allowed to alter anyway.
 * Answered out of trips_driver_rating_idx without touching the table.
 *
 * NULL for a driver nobody has rated, and that is the answer: a made-up
 * 5.0 on an empty record is the one figure a passenger cannot check.
 */
async function driverRating(driverId) {
  const [rows] = await pool.query(
    `SELECT ROUND(AVG(t.rating), 2) AS rating, COUNT(t.rating) AS ratings
       FROM trips t
      WHERE t.driver_id = :driverId
        AND t.rating IS NOT NULL`,
    { driverId },
  );
  const row = rows[0] || {};
  return {
    rating: row.rating === null || row.rating === undefined ? null : Number(row.rating),
    ratings: Number(row.ratings || 0),
  };
}

/**
 * Counts one wrong PIN, and closes the handover on the last of them.
 *
 * The increment is the read: `pin_attempts + 1` is evaluated by the
 * database against the row it is writing, so two keypads cannot both see
 * "four so far" and both be allowed a fifth. pin_locked_at is stamped on
 * the attempt that reaches the limit and never moved afterwards, so it
 * records when the lock closed rather than when it was last hit.
 */
async function registerPinFailure(tripId, limit) {
  await pool.query(
    `UPDATE trips
        SET pin_attempts = pin_attempts + 1,
            pin_locked_at = IF(pin_attempts + 1 >= :limit,
                               COALESCE(pin_locked_at, NOW()),
                               pin_locked_at)
      WHERE trip_id = :tripId`,
    { tripId, limit },
  );

  const [rows] = await pool.query(
    "SELECT pin_attempts FROM trips WHERE trip_id = :tripId LIMIT 1",
    { tripId },
  );
  return rows[0] ? Number(rows[0].pin_attempts) : limit;
}

/** Cancels every request nobody accepted inside the window. */
async function sweepStale(ttlMinutes) {
  await pool.query(
    `UPDATE trips
        SET status = 'cancelled',
            cancelled_by = 'system',
            cancel_reason = 'No driver accepted in time'
      WHERE status = 'requested'
        AND requested_at < (NOW() - INTERVAL :ttlMinutes MINUTE)`,
    { ttlMinutes },
  );
}

/**
 * Ends rides that stopped happening, and says whose they were.
 *
 * A request nobody takes is swept above; this is the other end of it — a
 * ride that WAS accepted and then went quiet, because a phone died on the
 * way to a pickup or an app was closed mid-journey. Such a row never
 * reaches a terminal status on its own, and while it sits there its driver
 * is 'on_trip' for ever: they cannot go online, cannot be offered anything,
 * and cannot accept anything, with no way back except somebody editing the
 * database.
 *
 * Hours, not minutes. A long journey is a normal thing, and cancelling one
 * out from under two people who are in it is far worse than leaving a dead
 * row an extra hour.
 *
 * The driver ids are read BEFORE the update because the update erases the
 * only link to them that matters here; the caller frees each one.
 */
async function sweepAbandoned(maxHours) {
  const [stuck] = await pool.query(
    `SELECT trip_id, driver_id
       FROM trips
      WHERE status IN ('matched','en_route_pickup','in_progress')
        AND updated_at < (NOW() - INTERVAL :maxHours HOUR)`,
    { maxHours },
  );
  if (stuck.length === 0) return [];

  await pool.query(
    `UPDATE trips
        SET status = 'cancelled',
            cancelled_by = 'system',
            cancel_reason = :reason
      WHERE status IN ('matched','en_route_pickup','in_progress')
        AND updated_at < (NOW() - INTERVAL :maxHours HOUR)`,
    { maxHours, reason: `Abandoned: nothing happened for ${maxHours} hours` },
  );

  return [...new Set(stuck.map((row) => row.driver_id).filter(Boolean))];
}

/** Both parties, for routing a realtime event. Not returned to any client. */
async function partiesOf(tripId) {
  const [rows] = await pool.query(
    "SELECT user_id, driver_id FROM trips WHERE trip_id = :tripId LIMIT 1",
    { tripId },
  );
  return rows[0] || null;
}

module.exports = {
  LIVE_STATUSES,
  columnForRole,
  create,
  findById,
  findByIdForParty,
  findLiveForAccount,
  findOpenNear,
  recordDecline,
  findDecline,
  claim,
  advance,
  rate,
  driverRating,
  registerPinFailure,
  sweepStale,
  sweepAbandoned,
  partiesOf,
};
