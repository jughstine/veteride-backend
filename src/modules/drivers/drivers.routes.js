const { Router } = require("express");
const controller = require("./drivers.controller");
const { validateBody } = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/authenticate");
const schemas = require("./drivers.schemas");

const router = Router();

// All routes require a logged-in driver; these actions occur after signup.
router.use(authenticate, requireRole("driver"));

router.post(
  "/me/verification-documents",
  validateBody(schemas.submitVerificationDocumentsSchema),
  controller.submitVerificationDocuments,
);

module.exports = router;
