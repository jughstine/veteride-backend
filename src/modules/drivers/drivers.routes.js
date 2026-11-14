const { Router } = require("express");
const controller = require("./drivers.controller");
const { validateBody, validateQuery } = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/authenticate");
const schemas = require("./drivers.schemas");
const tripsController = require("../trips/trips.controller");
const tripsSchemas = require("../trips/trips.schemas");
const walletController = require("../wallet/wallet.controller");
const walletSchemas = require("../wallet/wallet.schemas");

const router = Router();

// All routes require a logged-in driver; these actions occur after signup.
router.use(authenticate, requireRole("driver"));

// This driver's own row. Before the /me/* routes below only for the
// reading of it: Express matches "/me" and "/me/wallet" as distinct paths
// and neither shadows the other, so the order here is for a person
// reading the file.
router.get("/me", controller.me);

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

// Going online, and coming off. Separate from the position post above: a
// driver who is not working still reports where they are when the app is
// open, and a driver who is working is not online for as long as they have
// somebody in the vehicle.
router.post(
  "/me/availability",
  validateBody(schemas.availabilitySchema),
  controller.setAvailability,
);

// What this driver earned, out of the rides they actually finished.
router.get("/me/earnings", controller.earnings);

// The float the commission comes OUT of, which is the opposite direction
// from earnings above: money paid in, not money made. Separate routes
// because a driver asking "how much have I got left to drive on" is not
// asking what they earned.
//
// The driver is always req.user.id — never a path parameter — so one
// driver cannot read or spend another's balance.
router.get("/me/wallet", walletController.wallet);
router.get("/me/wallet/ledger", walletController.ledger);
router.post(
  "/me/topups",
  validateBody(walletSchemas.startTopupSchema),
  walletController.startTopup,
);

// Taking money back out — the opposite direction from /me/topups above, and
// the one that cannot be undone. Since 013 the wallet also receives the
// driver's earnings, so the balance is money we owe: a driver who cannot
// withdraw it has not been paid.
//
// The driver is always req.user.id, never a path parameter, so one driver
// cannot cash out another's balance.
router.post(
  "/me/payouts",
  validateBody(walletSchemas.requestPayoutSchema),
  walletController.requestPayout,
);
router.get(
  "/me/payouts",
  validateQuery(walletSchemas.payoutListQuerySchema),
  walletController.listPayouts,
);

module.exports = router;
