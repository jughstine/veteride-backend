const driverService = require("./drivers.service");
const asyncHandler = require("../../utils/asyncHandler");

const submitVerificationDocuments = asyncHandler(async (req, res) => {
  const driver = await driverService.submitVerificationDocuments(req.user.id, {
    dateOfBirth: req.body.date_of_birth,
    licenseNumber: req.body.license_number,
    licensePhotoUrl: req.body.license_photo_url,
    licenseExpiry: req.body.license_expiry,
    orCrPhotoUrl: req.body.or_cr_photo_url,
  });
  res.status(200).json(driver);
});

// Anything that is not an affirmative is offline. A switch has two
// positions, and a body that forgot to say which is not a third one.
const setAvailability = asyncHandler(async (req, res) => {
  const online =
    req.body.online === true || req.body.online === "true" || req.body.online === 1;
  res.status(200).json(await driverService.setAvailability(req.user.id, online));
});

const earnings = asyncHandler(async (req, res) => {
  res.status(200).json({ earnings: await driverService.earnings(req.user.id) });
});

module.exports = { submitVerificationDocuments, setAvailability, earnings };
