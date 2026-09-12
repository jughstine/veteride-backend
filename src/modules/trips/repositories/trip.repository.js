const crypto = require("crypto");
const pool = require("../../../config/db");

/** Columns every read of a trip returns, so the shapes never drift apart. */
const TRIP_COLUMNS = `
  t.trip_id, t.user_id, t.driver_id, t.status,
  t.pickup_address, t.pickup_lat, t.pickup_lng,
  t.dropoff_address, t.dropoff_lat, t.dropoff_lng,
  t.distance_km, t.estimated_minutes, t.estimated_fare, t.final_fare,
  t.pin, t.cancelled_by, t.cancel_reason,
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
}) {
  const tripId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO trips (
       trip_id, user_id, status,
       pickup_address, pickup_lat, pickup_lng,
       dropoff_address, dropoff_lat, dropoff_lng,
       distance_km, estimated_minutes, estimated_fare, pin
     ) VALUES (
       :tripId, :userId, 'requested',
       :pickupAddress, :pickupLat, :pickupLng,
       :dropoffAddress, :dropoffLat, :dropoffLng,
       :distanceKm, :estimatedMinutes, :estimatedFare, :pin
     )`,
    {
      tripId, userId,
      pickupAddress, pickupLat, pickupLng,
      dropoffAddress, dropoffLat, dropoffLng,
      distanceKm: distanceKm ?? null,
      estimatedMinutes: estimatedMinutes ?? null,
      estimatedFare: estimatedFare ?? null,
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
 * Unclaimed rides near a driver, nearest first.
 *
 * A bounding box in SQL and the exact distance in JS: MySQL has no spatial
 * index on plain DECIMAL columns, so the box is what `trips_open_idx`
 * can actually serve. One degree of latitude is ~111 km and a degree of
 * longitude is shorter than that everywhere off the equator, so the box is
 * generous in both directions and the precise filter below narrows it.
 */
async function findOpenNear({ lat, lng, radiusKm, ttlMinutes, limit = 10 }) {
  const degrees = radiusKm / 111.0;
  const [rows] = await pool.query(
    `SELECT ${TRIP_COLUMNS}, c.full_name AS rider_name
       FROM trips t
       JOIN customers c ON c.user_id = t.user_id
      WHERE t.status = 'requested'
        AND t.driver_id IS NULL
        AND t.requested_at > (NOW() - INTERVAL :ttlMinutes MINUTE)
        AND t.pickup_lat BETWEEN :south AND :north
        AND t.pickup_lng BETWEEN :west  AND :east
      ORDER BY t.requested_at ASC
      LIMIT :limit`,
    {
      ttlMinutes,
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
 * Takes an unclaimed ride for this driver.
 *
 * The WHERE clause is the whole lock. Two drivers tapping Accept in the
 * same second both run this UPDATE; the one that commits first leaves
 * `driver_id IS NULL` false, so the second matches zero rows and is told
 * it lost. Reading the row first and updating after would let both pass
 * the read before either wrote.
 */
async function claim(tripId, driverId) {
  const [result] = await pool.query(
    `UPDATE trips
        SET driver_id = :driverId,
            status    = 'matched',
            matched_at = NOW()
      WHERE trip_id = :tripId
        AND driver_id IS NULL
        AND status = 'requested'`,
    { tripId, driverId },
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
    en_route_pickup: "",
    in_progress: ", pickup_at = NOW()",
    completed: ", dropoff_at = NOW(), final_fare = COALESCE(final_fare, estimated_fare)",
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
  claim,
  advance,
  sweepStale,
  partiesOf,
};
