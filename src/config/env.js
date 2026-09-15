require("dotenv").config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * A tariff from two env vars, or null when either is missing.
 *
 * Null is the answer that keeps a price from being invented: a service
 * whose rate nobody has named is refused at booking rather than billed at
 * some other service's rate. Both halves are required together, because a
 * base fare with no per-kilometre rate prices every journey the same.
 */
function optionalTariff(baseVar, perKmVar) {
  const base = parseFloat(process.env[baseVar]);
  const perKm = parseFloat(process.env[perKmVar]);
  if (!Number.isFinite(base) || !Number.isFinite(perKm)) return null;
  if (base < 0 || perKm < 0) return null;
  return { base, perKm };
}

function requiredList(name) {
  const raw = required(name);
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`Env var ${name} must contain at least one value`);
  }
  return values;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "3000", 10),

  db: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  },

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET"),
    accessTtl: process.env.JWT_ACCESS_TTL || "15m",
  },

  refreshToken: {
    ttlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || "30", 10),
  },

  passwordReset: {
    ttlMinutes: parseInt(process.env.RESET_TOKEN_TTL_MIN || "30", 10),
  },

  google: {
    clientIds: requiredList("GOOGLE_CLIENT_IDS"),
  },

  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || "12", 10),

  uploads: {
    // Where the bytes live. A path on disk in development; in production a
    // mounted volume or object-storage mount, because a container's own
    // filesystem is discarded on every redeploy and these are the documents
    // a driver's approval depends on.
    dir: process.env.UPLOAD_DIR || "./uploads",

    // 8 MB. A phone photo of a licence is well under this; anything far over
    // is a mistake or an attempt to fill the disk.
    maxBytes: parseInt(process.env.UPLOAD_MAX_BYTES || String(8 * 1024 * 1024), 10),
  },

  rides: {
    // How far dispatch looks for a driver. The app states this number to
    // both sides ("bookings within 10 km"), so it is read from here rather
    // than written twice.
    offerRadiusKm: parseFloat(process.env.OFFER_RADIUS_KM || "10"),

    // A request nobody accepts inside this window is cancelled by the
    // system. Without it the open list fills with rides whose passengers
    // gave up and walked.
    requestTtlMinutes: parseInt(process.env.REQUEST_TTL_MIN || "15", 10),

    // A fix older than this is not a position. A driver whose phone went
    // to sleep an hour ago must not be offered a ride at their last known
    // junction.
    positionMaxAgeMinutes: parseInt(process.env.POSITION_MAX_AGE_MIN || "5", 10),

    // How close the driver must be before the passenger is told they have
    // arrived. Computed, not declared: there is no status for it.
    atPickupMetres: parseInt(process.env.AT_PICKUP_METRES || "120", 10),

    // Wrong PINs allowed before the handover is locked and the passenger
    // has to be asked to re-read it.
    pinAttempts: parseInt(process.env.PIN_ATTEMPTS || "5", 10),

    // A ride that has not moved in this long is abandoned: a phone that
    // died mid-trip, or a driver who closed the app on the way to a
    // pickup. Hours rather than the minutes a request gets, because a long
    // journey is a normal thing and cancelling one out from under two
    // people is not. Without it an in_progress row nobody will ever finish
    // holds its driver at 'on_trip' for ever, and they can never go online
    // again.
    liveTripMaxHours: parseInt(process.env.LIVE_TRIP_MAX_HOURS || "12", 10),

    // What a six-wheeler charges, as base fare and rate per kilometre.
    //
    // An OVERRIDE, not the default. The owner priced a truck as the car's
    // tariff plus ₱20 on the base fare (15 Sep 2026), which modules/trips/
    // fares.js derives from the car rate so the two move together — so this
    // is null in the common case and a truck is still priced. Setting both
    // TRUCK6_BASE_FARE and TRUCK6_PER_KM names a truck's own tariff outright
    // and takes over from the derived one, for the day a load is costed on
    // its own terms.
    truck6Tariff: optionalTariff("TRUCK6_BASE_FARE", "TRUCK6_PER_KM"),

    // The platform's cut of a fare, as a percentage.
    //
    // TEN, the rate the owner named (15 Sep 2026): the platform keeps 10% of
    // the fare and the driver earns the rest, and a tip is never part of it —
    // a gift carries no commission. Still overridable with COMMISSION_PCT so
    // the rate stays a setting and not a recompile, but no longer zero: a
    // fare that split nothing was a driver's whole fare and a platform that
    // ran for free, which is not the arrangement.
    commissionPercent: parseFloat(process.env.COMMISSION_PCT || "10"),
  },
};
