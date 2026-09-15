const AppError = require("../../utils/AppError");
const env = require("../../config/env");
const userRepo = require("../auth/repositories/user.repository");
const availabilityRepo = require("./repositories/availability.repository");
const earningsRepo = require("./repositories/earnings.repository");
const tripService = require("../trips/trips.service");

function stripSensitive(driverRow) {
  const { password_hash, ...safe } = driverRow;
  return safe;
}

/** The driver, or the 404 every route here gives for one that is gone. */
async function loadDriver(driverId) {
  const driver = await userRepo.findByIdForRole("driver", driverId);
  if (!driver) {
    throw new AppError(404, "PROFILE_NOT_FOUND", "Driver profile not found");
  }
  return driver;
}

// POST /drivers/me/verification-documents
// Collects driver verification documents after login and resets status to 'pending'
// for a fresh review on both initial submissions and resubmissions.
async function submitVerificationDocuments(
  driverId,
  { dateOfBirth, licenseNumber, licensePhotoUrl, licenseExpiry, orCrPhotoUrl },
) {
  const driver = await userRepo.findByIdForRole("driver", driverId);
  if (!driver) {
    throw new AppError(404, "PROFILE_NOT_FOUND", "Driver profile not found");
  }

  // Approved drivers changing license details require separate reverification
  // and must not automatically reset their status to 'pending'.
  if (driver.verification_status === "approved") {
    throw new AppError(
      409,
      "ALREADY_VERIFIED",
      "This driver is already verified. Contact support to update verification documents.",
    );
  }

  const taken = await userRepo.isLicenseNumberTakenByOtherDriver(
    licenseNumber,
    driverId,
  );
  if (taken) {
    throw new AppError(
      409,
      "LICENSE_NUMBER_TAKEN",
      "This license number is already registered",
    );
  }

  await userRepo.updateDriverVerificationDocuments(driverId, {
    date_of_birth: dateOfBirth,
    license_number: licenseNumber,
    license_photo_url: licensePhotoUrl,
    license_expiry: licenseExpiry,
    or_cr_photo_url: orCrPhotoUrl,
  });

  const updated = await userRepo.findByIdForRole("driver", driverId);
  return stripSensitive(updated);
}

// POST /drivers/me/availability — the online switch.
//
// Going online is a CLAIM the server accepts or refuses, not a fact the
// phone announces: the app's toggle waits for this answer and snaps back
// when it is refused, because a driver shown as available to nobody is
// worse than a driver who knows they are offline.
async function setAvailability(driverId, online) {
  const driver = await loadDriver(driverId);

  // Approval is read before the write so the driver gets a sentence about
  // their documents rather than a refusal with no subject. An unapproved
  // driver cannot be offered anything and cannot accept anything, so
  // letting them switch themselves "online" would be a light that means
  // nothing.
  if (driver.verification_status !== "approved") {
    throw new AppError(403, "NOT_VERIFIED", "Your documents are not approved yet");
  }

  // A ride nobody will ever finish holds its driver at 'on_trip' for ever;
  // the sweep is what stops that being permanent, and it runs here because
  // this is the request such a driver makes when they find they are stuck.
  await tripService.sweep();

  // Availability during a ride is 'on_trip', and it belongs to the trip
  // rather than to the switch — in BOTH directions. Flipping to offline
  // mid-ride would strand a passenger watching a driver who is still
  // driving; flipping to online would say the ride is not happening. The
  // trip travels with the refusal so the app can land them on it instead
  // of telling them to finish a ride it gives them no way to reach.
  const live = await tripService.current(driverId, "driver");
  if (live) {
    throw new AppError(409, "RIDE_IN_PROGRESS", "Finish your current ride first", {
      trip: live,
    });
  }

  const status = await availabilityRepo.set(driverId, online ? "online" : "offline");
  return { ok: true, availability_status: status };
}

/** Monday first, and the names the dashboard's seven bars are labelled with. */
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Whole pesos. The app formats; it never divides. */
const pesos = (value) => Math.round(Number(value) || 0);

/** The nth day of the week, as the same 'YYYY-MM-DD' string SQL returned. */
function dayAfter(startDate, offset) {
  const start = new Date(`${startDate}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() + offset);
  return start.toISOString().slice(0, 10);
}

// GET /drivers/me/earnings — today and this week, from the rides themselves.
//
// Every figure is summed from completed trips at read time. A driver who
// has finished nothing gets zeros, and those zeros are a measurement: there
// is no seeded number anywhere in this, and nothing here invents money.
async function earnings(driverId) {
  await loadDriver(driverId);

  const { week_start: weekStart, today } = await earningsRepo.weekWindow();
  const rows = await earningsRepo.dailyTotals(driverId, weekStart);
  const byDay = new Map(rows.map((row) => [row.day, row]));

  // Rounded per day and then added up, rather than rounded at the end: the
  // week's total is what the seven bars come to, and a total that is a peso
  // off the bars under it is the kind of thing a driver counts twice.
  const days = [];
  const week = { net: 0, gross: 0, commission: 0, tips: 0, allowance: 0 };
  let todayTotals = { net: 0, trips: 0, gross: 0, commission: 0, tips: 0 };

  for (let offset = 0; offset < 7; offset += 1) {
    const date = dayAfter(weekStart, offset);
    const row = byDay.get(date);

    const gross = pesos(row?.gross);
    const commission = pesos((gross * env.rides.commissionPercent) / 100);
    // What this driver's passengers actually added, out of the rating they
    // left with it. Commission is taken on the fare and never on the tip.
    const tips = pesos(row?.tips);
    // Nothing records a daily allowance. It is present and zero because
    // the dashboard draws a line for it; a figure put here would be one
    // this server made up.
    const allowance = 0;
    const net = gross - commission + tips;

    days.push({ day: DAY_NAMES[offset], net });
    week.gross += gross;
    week.commission += commission;
    week.tips += tips;
    week.allowance += allowance;
    week.net += net;

    if (date === today) {
      todayTotals = {
        net,
        trips: Number(row?.trips_count || 0),
        gross,
        commission,
        tips,
      };
    }
  }

  return { today: todayTotals, week: { ...week, days } };
}

module.exports = { submitVerificationDocuments, setAvailability, earnings };
