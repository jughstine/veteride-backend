const pool = require("../../../config/db");

/**
 * Where a driver is now, overwritten on every post.
 *
 * No history: what dispatch asks is "who is near this pickup", and a row
 * per fix would be millions of rows answering a question nobody asks.
 */
async function upsert(driverId, { lat, lng, heading, accuracyM }) {
  await pool.query(
    `INSERT INTO driver_positions (driver_id, lat, lng, heading, accuracy_m)
     VALUES (:driverId, :lat, :lng, :heading, :accuracyM)
     ON DUPLICATE KEY UPDATE
       lat = VALUES(lat),
       lng = VALUES(lng),
       heading = VALUES(heading),
       accuracy_m = VALUES(accuracy_m)`,
    {
      driverId,
      lat,
      lng,
      heading: heading ?? null,
      accuracyM: accuracyM ?? null,
    },
  );
}

async function findByDriver(driverId) {
  const [rows] = await pool.query(
    `SELECT driver_id, lat, lng, heading, updated_at
       FROM driver_positions
      WHERE driver_id = :driverId
      LIMIT 1`,
    { driverId },
  );
  return rows[0] || null;
}

/**
 * Drivers whose last fix is recent and inside the box.
 *
 * Used to decide who a new booking is announced to. The exact distance is
 * applied by the caller — see the note in trip.repository.findOpenNear on
 * why the box is what the index can serve.
 */
async function findFreshInBox({ lat, lng, radiusKm, maxAgeMinutes }) {
  const degrees = radiusKm / 111.0;
  const [rows] = await pool.query(
    `SELECT driver_id, lat, lng
       FROM driver_positions
      WHERE updated_at > (NOW() - INTERVAL :maxAgeMinutes MINUTE)
        AND lat BETWEEN :south AND :north
        AND lng BETWEEN :west  AND :east`,
    {
      maxAgeMinutes,
      south: lat - degrees,
      north: lat + degrees,
      west: lng - degrees,
      east: lng + degrees,
    },
  );
  return rows;
}

module.exports = { upsert, findByDriver, findFreshInBox };
