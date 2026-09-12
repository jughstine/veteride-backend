const { Router } = require("express");
const controller = require("./drivers.controller");
const { validateBody } = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/authenticate");
const schemas = require("./drivers.schemas");
const tripsController = require("../trips/trips.controller");
const tripsSchemas = require("../trips/trips.schemas");

const router = Router();

// All routes require a logged-in driver; these actions occur after signup.
router.use(authenticate, requireRole("driver"));

router.post(
  "/me/verification-documents",
  validateBody(schemas.submitVerificationDocumentsSchema),
  controller.submitVerificationDocuments,
);

// Where this driver is now. Lives on the driver router rather than under
// /trips because a driver posts their position whether or not they are
// carrying anyone — dispatch needs it most when they are idle.
router.post(
  "/me/position",
  validateBody(tripsSchemas.positionSchema),
  tripsController.postPosition,
);

module.exports = router;
