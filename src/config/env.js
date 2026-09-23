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

  // Outgoing mail. NO DEFAULTS, deliberately.
  //
  // Every other setting in this file can fall back to something sensible
  // because a wrong guess costs a wrong number. A guessed mail server costs
  // a sign-in code delivered to somebody else's relay, so the answer when
  // these are unset is null, `required()` is not used on them, and the
  // server boots without them: src/utils/mailer.js reports itself
  // unconfigured and POST /auth/email-code refuses with a 503 that names
  // the reason. Everything else in the API carries on working.
  //
  // The deployed server holds the real Gmail values in its own .env.
  mail: {
    host: process.env.SMTP_HOST || null,
    port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : null,
    // A relay that wants no credentials is a valid relay, so these two stay
    // optional; mailer.js sends AUTH only when both are present.
    user: process.env.SMTP_USER || null,
    pass: process.env.SMTP_PASS || null,
    from: process.env.MAIL_FROM || null,
  },

  emailCode: {
    // How long six digits are worth anything. TEN MINUTES: long enough to
    // fetch a phone from the next room and for the mail to clear a slow
    // relay, short enough that a code left open on a screen at lunchtime is
    // dead by the time anybody walks past it.
    ttlMinutes: parseInt(process.env.EMAIL_CODE_TTL_MIN || "10", 10),

    // Wrong guesses before the code dies and a new one has to be asked for.
    // FIVE, the same allowance the handover PIN gets. A million
    // combinations is a wall for a person and a half-second for a script;
    // this is the number that makes the difference, not the length of the
    // code.
    maxAttempts: parseInt(process.env.EMAIL_CODE_MAX_ATTEMPTS || "5", 10),
  },

  // The optional authenticator (TOTP). Nothing here is required: an account
  // that never enrols is never challenged, so a server with none of these set
  // behaves exactly as it did before the feature existed.
  authenticator: {
    // How long a stopped sign-in may be finished. FIVE MINUTES: long enough
    // to fetch a phone and read six digits, short enough that a challenge
    // captured off a screen is worthless by the time anybody uses it.
    challengeTtlMinutes: parseInt(
      process.env.AUTHENTICATOR_CHALLENGE_TTL_MIN || "5",
      10,
    ),
    // Wrong codes in a row before the account stops answering. Six digits is
    // a million, and a 90-second window is wide enough for a script to try a
    // great many of them; this count is what actually closes it.
    maxAttempts: parseInt(process.env.AUTHENTICATOR_MAX_ATTEMPTS || "5", 10),
    // How long the door stays shut once the count runs out. FIFTEEN MINUTES:
    // long enough to make guessing pointless, short enough that somebody who
    // simply mistyped is not locked out of their evening. It has to be a
    // wait rather than a permanent lock — every route that would clear the
    // count is one a locked-out account can no longer reach.
    lockMinutes: parseInt(process.env.AUTHENTICATOR_LOCK_MIN || "15", 10),
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

    // How long a booking stays out of sight of the ONE DRIVER who passed on
    // it. The owner's rule (17 Sep 2026): "if the driver did not accept the
    // request for 30 seconds the passenger will keep looking for other
    // available drivers." Nothing is reserved for that driver and nothing is
    // taken from anybody else — every other driver in range goes on seeing
    // the row throughout — so this is the interval that makes the rotation
    // real: without it GET /trips/open hands the same booking back to the
    // same driver two seconds later, for ever.
    //
    // THREE MINUTES, and both ends of that number matter. Long enough that
    // the booking reaches everyone else first: six 30-second cards' worth.
    // Short enough to be a fraction of requestTtlMinutes (15), so a booking
    // every driver in range has passed on comes BACK to them with time to
    // spare rather than dying unseen — a passenger is not stranded by having
    // been unlucky in who polled first. A value at or above the TTL would
    // quietly turn one driver's decline into a cancellation, which is the
    // one thing a decline must never be.
    declineCooloffMinutes: parseInt(process.env.DECLINE_COOLOFF_MIN || "3", 10),

    // A fix older than this is not a position. A driver whose phone went
    // to sleep an hour ago must not be offered a ride at their last known
    // junction.
    positionMaxAgeMinutes: parseInt(process.env.POSITION_MAX_AGE_MIN || "5", 10),

    // How close the driver must be before the passenger is told they have
    // arrived. Computed, not declared: there is no status for it.
    atPickupMetres: parseInt(process.env.AT_PICKUP_METRES || "120", 10),

    // How old a driver's last fix may be and still count as "near me" when a
    // passenger asks which vehicles are available. FIVE MINUTES: a phone that
    // has not reported in longer than that is a driver who has closed the app
    // or lost signal, and answering "yes, a six-seater is here" on the
    // strength of where somebody was half an hour ago is a promise nobody
    // made.
    positionTtlMinutes: parseInt(process.env.POSITION_TTL_MIN || "5", 10),

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
