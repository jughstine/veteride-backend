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

module.exports = { submitVerificationDocuments };
