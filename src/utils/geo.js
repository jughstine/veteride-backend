/**
 * Metres between two points, equirectangular.
 *
 * Plenty for "is this driver near that pickup": the error against the
 * haversine is under a metre at city scale, and it avoids a dependency for
 * one comparison.
 *
 * Here rather than in trips.service.js, where it started, because pricing
 * needs the same number: the straight line between the two addresses is the
 * floor under a ride's distance, and two copies of this sum are two floors
 * that drift apart.
 */
function metresBetween(lat1, lng1, lat2, lng2) {
  const metresPerDegree = 111_320;
  const dLat = (lat2 - lat1) * metresPerDegree;
  const dLng =
    (lng2 - lng1) * metresPerDegree * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

module.exports = { metresBetween };
