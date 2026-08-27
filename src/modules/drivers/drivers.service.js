const AppError = require("../../utils/AppError");
const userRepo = require("../auth/repositories/user.repository");

function stripSensitive(driverRow) {
  const { password_hash, ...safe } = driverRow;
  return safe;
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

module.exports = { submitVerificationDocuments };
