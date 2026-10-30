const paymongo = require("../wallet/paymongo");
const walletService = require("../wallet/wallet.service");
const paymentRepo = require("./repositories/payment.repository");
const fares = require("./fares");
const AppError = require("../../utils/AppError");
const logger = require("../../utils/logger");

/**
 * A fare paid through the gateway instead of into the driver's hand.
 *
 * THE TWO WAYS A RIDE IS PAID FOR, and they settle in opposite directions:
 *
 *   cash   passenger -> driver's hand.    VeteRide's 12% comes OUT of the
 *                                         driver's prepaid float.
 *   QR Ph  passenger -> VeteRide PayMongo. The 12% is kept at source and
 *                                         the rest goes INTO the float.
 *
 * So a gateway-paid ride must not ALSO have the commission taken from the
 * float — that would charge the driver twice for one ride. `recordFare` in
 * trips.service.js is where that fork is made; this module is the gateway
 * half of it.
 *
 * WHAT THIS MODULE NEVER DOES is decide that money arrived. It opens a
 * charge and writes a row that says `pending`; only the webhook, carrying
 * PayMongo's own confirmation, may turn that into `completed` and credit
 * anybody. The CHECK in 005_fares.sql enforces the same thing at the
 * database: a completed gateway payment without a gateway reference cannot
 * be written at all.
 */

/** Only QR Ph today. GCash and Maya join this list when PayMongo enables them. */
const GATEWAY_METHODS = new Set(["qrph"]);

/** Whether a ride booked with this method is settled by the gateway. */
function isGatewayMethod(method) {
  return GATEWAY_METHODS.has(String(method || "").toLowerCase());
}

/**
 * Opens a QR Ph charge for a finished ride and returns the code to scan.
 *
 * The amount is the FINAL fare, which is why this cannot run before the
 * drop-off: the server re-prices from its own tariff, and a charge raised
 * at booking would need a refund every time the ride was shorter than the
 * estimate.
 */
async function startFarePayment({ trip, origin }) {
  if (!trip) throw new AppError(404, "NOT_FOUND", "No such trip");
  if (!paymongo.enabled()) {
    throw new AppError(503, "NO_GATEWAY", "Paying in the app is not available right now.");
  }

  const fare = fares.toCentavo(trip.final_fare ?? trip.estimated_fare ?? 0);
  if (!(fare > 0)) {
    throw new AppError(409, "NO_FARE", "This ride has no fare to pay yet.");
  }

  const existing = await paymentRepo.findForTrip(trip.trip_id);
  if (existing && existing.status === "completed") {
    throw new AppError(409, "ALREADY_PAID", "This ride is already paid for.");
  }

  const commission = fares.commissionOn(fare);
  const earnings = fares.toCentavo(fare - commission);

  let started;
  try {
    started = await paymongo.startIntentCheckout({
      amount: fare,
      type: "qrph",
      returnUrl: `${origin}/wallet/topup-done?ok=1`,
    });
  } catch (error) {
    // A refusal is the gateway answering, not a bad gateway - and a 5xx
    // body is replaced by Cloudflare, so the reason would never reach the
    // passenger. Same rule as the top-up path.
    const refused = Number(error.status) >= 400 && Number(error.status) < 500;
    throw new AppError(
      refused ? 400 : 502,
      refused ? "GATEWAY_REFUSED" : "GATEWAY_ERROR",
      error.message,
    );
  }

  await paymentRepo.openGatewayPayment({
    tripId: trip.trip_id,
    riderId: trip.user_id,
    amount: fare,
    method: "qrph",
    platformFee: commission,
    driverEarnings: earnings,
    gatewayRef: started.intentId,
  });

  return {
    trip_id: trip.trip_id,
    amount_minor: Math.round(fare * 100),
    platform_fee_minor: Math.round(commission * 100),
    driver_earnings_minor: Math.round(earnings * 100),
    method: "qrph",
    status: "pending",
    flow: started.flow,
    checkout_url: started.checkoutUrl,
    qr_image: started.qrImage,
  };
}

/**
 * PayMongo says a fare was paid: settle the receipt and credit the driver.
 *
 * Returns `{ handled: false }` when the reference belongs to something else
 * — a driver top-up, most likely — so the webhook can try the other
 * handler rather than treating an unknown id as an error.
 *
 * Credited exactly once, twice over: `completeGatewayPayment` only reports
 * success for the delivery that actually flipped the row, and the wallet
 * ledger's (trip_id, kind) unique key refuses a second 'fare' row anyway.
 * PayMongo retries, so one guard is not enough to rest on.
 */
async function creditFareFromIntent({ intentId }) {
  const payment = await paymentRepo.findByGatewayRef(intentId);
  if (!payment) return { handled: false };
  if (payment.status === "completed") return { handled: true, already: true };

  const settled = await paymentRepo.completeGatewayPayment({
    tripId: payment.trip_id,
    gatewayRef: intentId,
  });
  if (!settled) return { handled: true, already: true };

  if (!payment.driver_id) {
    // A paid ride with no driver on it is a broken row, not a credit to
    // guess at. The money is recorded; somebody has to look at this.
    logger.error?.(`fare paid for trip ${payment.trip_id} with no driver`);
    return { handled: true, credited: false, reason: "no driver on the trip" };
  }

  const balance = await walletService.creditDriverFare({
    driverId: payment.driver_id,
    tripId: payment.trip_id,
    pesos: Number(payment.driver_earnings),
  });

  return {
    handled: true,
    credited: balance !== null,
    trip_id: payment.trip_id,
    balance,
  };
}

module.exports = {
  GATEWAY_METHODS,
  isGatewayMethod,
  startFarePayment,
  creditFareFromIntent,
};
