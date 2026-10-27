const walletService = require("./wallet.service");
const asyncHandler = require("../../utils/asyncHandler");

const wallet = asyncHandler(async (req, res) => {
  res.status(200).json(await walletService.wallet(req.user.id));
});

const ledger = asyncHandler(async (req, res) => {
  res.status(200).json({
    items: await walletService.ledger(req.user.id, req.query.limit),
  });
});

/**
 * Opens a top-up. 201 with a checkout URL, and NOTHING credited — the
 * driver has not paid yet at this point.
 *
 * The driver comes from the token, never from the body: a driver_id a
 * caller could choose is a driver_id a caller could choose somebody else's.
 */
const startTopup = asyncHandler(async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  res.status(201).json(
    await walletService.startTopup({
      driverId: req.user.id,
      amount: req.body.amount,
      method: req.body.method,
      origin: `${proto}://${req.get("host")}`,
    }),
  );
});

module.exports = { wallet, ledger, startTopup };
