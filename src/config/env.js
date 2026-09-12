require("dotenv").config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
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
  },
};
