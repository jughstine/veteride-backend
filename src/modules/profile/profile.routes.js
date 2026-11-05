const { Router } = require("express");
const controller = require("./profile.controller");
const {
  validateBody,
  validateParams,
  validateQuery,
} = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/authenticate");
const schemas = require("./profile.schemas");

const router = Router();

// DECLARED ABOVE THE RIDER GATE, AND IT HAS TO BE.
//
// router.use() runs BEFORE route matching, so everything below the next
// line answers a driver with 403 — whether the route exists or not. That
// is not a theory: before this route was written, a driver signing in on a
// handset logged
//
//     VeteRide: push token refused (FORBIDDEN)
//
// which is this gate refusing a path that did not exist yet. Moved below,
// this route would produce that same line, the same silence, and the same
// appearance of having shipped. See docs/the-sql-that-is-left.md.
//
// Both roles carry a phone. The driver is the one who cannot work without
// it: no row here means no booking offer ever reaches a pocket.
router.post(
  "/push-token",
  authenticate,
  validateBody(schemas.pushTokenSchema),
  controller.savePushToken,
);

// All routes BELOW require a valid access token and rider role.
router.use(authenticate, requireRole("rider"));

router.get("/", controller.getMe);
router.patch(
  "/",
  validateBody(schemas.updateProfileSchema),
  controller.updateMe,
);
router.patch(
  "/preferences",
  validateBody(schemas.updatePreferencesSchema),
  controller.updatePreferences,
);
router.delete(
  "/",
  validateBody(schemas.deleteAccountSchema),
  controller.deleteMe,
);

router.get("/places", controller.listPlaces);
router.post(
  "/places",
  validateBody(schemas.createPlaceSchema),
  controller.createPlace,
);
router.delete(
  "/places/:id",
  validateParams(schemas.idParamSchema),
  controller.deletePlace,
);

// POST /me/payment-methods is deferred until the payment gateway integration is ready.
router.get("/payment-methods", controller.listPaymentMethods);
router.delete(
  "/payment-methods/:id",
  validateParams(schemas.idParamSchema),
  controller.deletePaymentMethod,
);

// POST /me/wallet/top-ups is deferred until the payment gateway integration is ready.
router.get("/wallet", controller.getWallet);
router.get(
  "/wallet/ledger",
  validateQuery(schemas.walletLedgerQuerySchema),
  controller.getWalletLedger,
);

module.exports = router;
