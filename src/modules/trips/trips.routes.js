const { Router } = require("express");
const controller = require("./trips.controller");
const {
  validateBody,
  validateParams,
  validateQuery,
} = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/authenticate");
const schemas = require("./trips.schemas");

const router = Router();

// Every route here needs a signed-in account. Applied at the router so a
// route added later cannot be left open by forgetting a line.
router.use(authenticate);

// --- The driver's open list. Before /:tripId, or "open" is read as an id. ---
router.get(
  "/open",
  requireRole("driver"),
  validateQuery(schemas.openQuerySchema),
  controller.openRequests,
);

// --- The ride this account is in the middle of, either side of it. ---
router.get("/mine", controller.current);

// --- What this account has finished with. Before /:tripId, or "history" is
//     read as a trip id. ---
router.get(
  "/history",
  validateQuery(schemas.historyQuerySchema),
  controller.history,
);

// --- Which classes could take a booking from a point, yes or no. Before
//     /:tripId for the same reason. ---
router.get(
  "/availability",
  requireRole("rider"),
  validateQuery(schemas.availabilityQuerySchema),
  controller.availability,
);

// --- Booking is the passenger's. ---
router.post(
  "/",
  requireRole("rider"),
  validateBody(schemas.bookSchema),
  controller.book,
);

router.get(
  "/:tripId",
  validateParams(schemas.tripIdParams),
  controller.readOne,
);

router.post(
  "/:tripId/accept",
  requireRole("driver"),
  validateParams(schemas.tripIdParams),
  controller.accept,
);

// The other half of the accept: this driver passes, and the booking moves
// on to the others. Driver-only and validated exactly like the accept above,
// and the driver is the SESSION's — `req.user.id`, never a body or a path
// segment — so nobody can pass on a stranger's behalf. It changes no status:
// the ride stays open for every other driver of the right class.
router.post(
  "/:tripId/decline",
  requireRole("driver"),
  validateParams(schemas.tripIdParams),
  controller.decline,
);

// One transition. Who may cause it is decided in the service from the
// session's role, never from the body.
router.post(
  "/:tripId/status",
  validateParams(schemas.tripIdParams),
  validateBody(schemas.statusSchema),
  controller.advance,
);

// The verdict on a finished ride, and the tip that comes with it. The
// passenger's alone — nothing in this build rates a passenger — and the
// service scopes the read on user_id to keep it that way.
router.post(
  "/:tripId/rating",
  requireRole("rider"),
  validateParams(schemas.tripIdParams),
  validateBody(schemas.ratingSchema),
  controller.rate,
);

// --- The ride's thread. Both ends read the same rows. ---
router.get(
  "/:tripId/messages",
  validateParams(schemas.tripIdParams),
  controller.readMessages,
);

router.post(
  "/:tripId/messages",
  validateParams(schemas.tripIdParams),
  validateBody(schemas.messageSchema),
  controller.postMessage,
);

module.exports = router;
