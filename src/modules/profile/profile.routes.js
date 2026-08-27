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

// All routes require a valid access token and rider role.
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
