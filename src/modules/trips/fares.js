const env = require("../../config/env");
const { metresBetween } = require("../../utils/geo");

/**
 * What a ride costs, decided HERE rather than taken from the handset.
 *
 * `estimated_fare` arrived in the booking body and was stored as sent,
 * checked only for being a non-negative number — and completing a trip
 * copies estimated_fare into final_fare. A booking sent with
 * `"estimated_fare": 0` was therefore offered to drivers as a ₱0 job and
 * recorded as a ₱0 ride however far it went, and any other number between
 * zero and ninety-nine million would have been honoured the same way.
 *
 * The figures are the app's own — app/lib/data.dart — and they must stay
 * the app's: a server that prices a ride differently from the screen the
 * passenger tapped is quoting one number and billing another. The
 * PostgreSQL reference backend prices from the same table for the same
 * reason, and the two must not drift.
 */
const TARIFF = {
  // VeteMoto and VeteSend. A parcel on a motorcycle is a different price
  // from a passenger on one, which is why the key is the pair and not the
  // class alone.
  "motorcycle:ride": { base: 65, perKm: 5.75 },
  "motorcycle:parcel": { base: 80, perKm: 7.5 },
  // VeteCar, and a parcel carried by one. The app has no car-parcel
  // service yet; when it grows one it will be this price, because that is
  // what the vehicle costs to send out.
  "car:ride": { base: 150, perKm: 16.5 },
  "car:parcel": { base: 150, perKm: 16.5 },
};

/** What the owner added to a car's base fare to make a six-wheeler's. */
const TRUCK6_BASE_SURCHARGE = 20;

/**
 * The tariff for one booking, or null if this service has no published one.
 *
 * A six-wheeler is priced as the car of the same service plus ₱20 on the
 * base fare, the owner's rule (15 Sep 2026): a truck had no price anywhere
 * — not in the app, not in the reference backend — and rather than refuse
 * every truck booking with NO_TARIFF, the car's rate is the floor it is
 * built on and the surcharge is the difference the owner named. Derived,
 * not copied: the car rate and the truck rate move together, so a change to
 * one is a change to both and they cannot drift. An explicit
 * TRUCK6_BASE_FARE/TRUCK6_PER_KM in the environment still wins, for the day
 * a load is costed on its own terms rather than off the car's.
 */
function tariffFor(vehicleClass, service) {
  if (vehicleClass === "truck6") {
    if (env.rides.truck6Tariff) return env.rides.truck6Tariff;
    const car = TARIFF[`car:${service}`];
    if (!car) return null;
    return { base: car.base + TRUCK6_BASE_SURCHARGE, perKm: car.perKm };
  }
  return TARIFF[`${vehicleClass}:${service}`] || null;
}

/** Rounded to the centavo, the way a settlement report rounds it. */
const toCentavo = (value) => Math.round((Number(value) || 0) * 100) / 100;

/**
 * The distance and the fare for one booking, or null if it cannot be priced.
 *
 * Two things this can check for itself: the tariff above, and the straight
 * line between the coordinates in the request. A road route is never
 * SHORTER than the straight line, so that is a floor under the distance;
 * three times it plus three kilometres is a ceiling no real route reaches,
 * which is what stops a two-kilometre trip being billed as two hundred.
 * Between the two the client's own measured route distance stands, so an
 * honest booking is priced at exactly the figure its screen showed and
 * nothing moves.
 */
function price({
  vehicleClass,
  service,
  distanceKm,
  pickupLat,
  pickupLng,
  dropoffLat,
  dropoffLng,
}) {
  const tariff = tariffFor(vehicleClass, service);
  if (!tariff) return null;

  const straight =
    metresBetween(pickupLat, pickupLng, dropoffLat, dropoffLng) / 1000;
  const measured = Number.isFinite(distanceKm) ? Number(distanceKm) : 0;

  // distance_km is DECIMAL(6,2); two coordinates on opposite sides of the
  // planet would otherwise put the floor past the column and turn a
  // nonsense booking into a numeric overflow instead of a readable fare.
  const km = toCentavo(
    Math.min(
      Math.max(measured, straight),
      Math.max(straight * 3, straight + 3),
      9999,
    ),
  );

  // Priced off the rounded distance, not the raw one, so the kilometres on
  // the receipt are the kilometres the fare was worked out from.
  return { distanceKm: km, fare: Math.round(tariff.base + tariff.perKm * km) };
}

/**
 * The platform's cut of a fare.
 *
 * Zero until the owner names a rate, which is what config/env.js defaults
 * it to: a percentage guessed here is read off the driver's dashboard as
 * money they actually lost.
 */
function commissionOn(amount) {
  return toCentavo(((Number(amount) || 0) * env.rides.commissionPercent) / 100);
}

module.exports = { TARIFF, tariffFor, price, commissionOn, toCentavo };
