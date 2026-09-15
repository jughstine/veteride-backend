const { Router } = require("express");
const controller = require("./admin.controller");
const {
  validateBody,
  validateParams,
  validateQuery,
} = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/authenticate");
const schemas = require("./admin.schemas");

const router = Router();

// The whole console is admins only. Applied at the router so a route added
// later cannot be left open by forgetting a line — a rider or driver token
// gets 403 here, and an unauthenticated call 401, before any handler runs.
router.use(authenticate, requireRole("admin"));

// --- Reads the console renders ---

router.get("/overview", controller.overview);

router.get("/riders", validateQuery(schemas.ridersQuery), controller.listRiders);

router.get("/drivers", validateQuery(schemas.driversQuery), controller.listDrivers);

router.get("/payments", validateQuery(schemas.paymentsQuery), controller.listPayments);

router.get("/documents", validateQuery(schemas.documentsQuery), controller.listDocuments);

// Before /trips/:tripId is not a concern here (no /trips/open equivalent),
// but the list stays above the detail for readability.
router.get("/trips", validateQuery(schemas.tripsQuery), controller.listTrips);

router.get(
  "/trips/:tripId",
  validateParams(schemas.tripIdParams),
  controller.getTrip,
);

// --- Writes the console performs ---

// Approve / reject / require-resubmission on a driver's verification.
router.post(
  "/drivers/:driverId/verification",
  validateParams(schemas.driverIdParams),
  validateBody(schemas.verificationBody),
  controller.setDriverVerification,
);

// Register a vehicle for a driver — without which no driver can be offered
// work, since dispatch classifies a driver by their vehicle.
router.post(
  "/drivers/:driverId/vehicles",
  validateParams(schemas.driverIdParams),
  validateBody(schemas.vehicleCreateBody),
  controller.createVehicle,
);

// Update a vehicle (plate, model, type, normalised class, colour, or its
// own verification state).
router.patch(
  "/vehicles/:vehicleId",
  validateParams(schemas.vehicleIdParams),
  validateBody(schemas.vehicleUpdateBody),
  controller.updateVehicle,
);

// Approve / reject / require-resubmission on one uploaded document.
router.post(
  "/documents/:uploadId/review",
  validateParams(schemas.uploadIdParams),
  validateBody(schemas.documentReviewBody),
  controller.reviewDocument,
);

// Suspend / restore a rider or a driver, in the status column auth reads.
router.post(
  "/accounts/:role/:accountId/status",
  validateParams(schemas.accountParams),
  validateBody(schemas.accountStatusBody),
  controller.setAccountStatus,
);

// End a stuck ride. Admin-only, recorded as cancelled_by 'system' — the one
// way an in_progress ride ends from a console, since neither party may
// cancel one.
router.post(
  "/trips/:tripId/cancel",
  validateParams(schemas.tripIdParams),
  validateBody(schemas.cancelTripBody),
  controller.cancelTrip,
);

module.exports = router;
