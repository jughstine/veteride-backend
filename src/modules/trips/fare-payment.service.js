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
async function startFarePayment({ trip, origin, role }) {
  if (!trip) throw new AppError(404, "NOT_FOUND", "No such trip");
  if (!paymongo.enabled()) {
    throw new AppError(503, "NO_GATEWAY", "Paying in the app is not available right now.");
  }

  // THE PASSENGER PAYS. findByIdForParty lets a driver read their own ride
  // too, so without this a driver could raise the charge on a ride they
  // drove - and the credit for it lands in their own float.
  if (role !== "rider") {
    throw new AppError(403, "RIDER_ONLY", "Only the passenger can pay for a ride.");
  }

  // Booked to be settled this way, or not at all. Without this a CASH ride
  // could be paid through the gateway - and a cash ride has ALREADY had the
  // commission taken out of the float, so the driver would be credited the
  // fare on top of keeping the cash. One ride, paid for twice.
  if (!isGatewayMethod(trip.payment_method)) {
    throw new AppError(
      409,
      "NOT_A_GATEWAY_RIDE",
      "This ride was booked to be paid in cash.",
    );
  }

  // Only once the ride is over. The fare is the FINAL one and never the
  // estimate: this server re-prices from its own tariff at the drop-off, so
  // a charge raised against the estimate would be the wrong amount on every
  // ride that ran short - and a refund VeteRide cannot make.
  if (trip.status !== "completed") {
    throw new AppError(409, "NOT_COMPLETED", "This ride is not finished yet.");
  }
  const fare = fares.toCentavo(trip.final_fare ?? 0);
  if (!(fare > 0)) {
    throw new AppError(409, "NO_FARE", "This ride has no final fare yet.");
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

  // HOW MUCH TO CREDIT DEPENDS ON WHETHER THE 12% WAS ACTUALLY TAKEN.
  //
  // The full fare is only right where the commission has already been
  // debited - the two are a pair, and the driver nets fare-minus-12% across
  // them. But the debit at completion is fire-and-forget by design: a ride
  // must not fail to finish because the wallet would not take a row. So it
  // can be missing, and crediting the full fare against a commission nobody
  // took hands the driver VeteRide's cut.
  //
  // Asked of the LEDGER, not assumed from the code path. Where the debit is
  // missing the driver is credited their share instead, which lands them on
  // the same net figure and keeps the platform's 12% either way. Both
  // branches are idempotent: (trip_id, kind) refuses a second 'fare' row.
  const charged = await walletService.commissionTaken(payment.trip_id);
  const credit = charged ? Number(payment.amount) : Number(payment.driver_earnings);
  if (!charged) {
    logger.warn?.(
      `trip ${payment.trip_id} paid by gateway with no commission row; ` +
        `crediting the driver's share (${credit}) rather than the full fare`,
    );
  }

  const balance = await walletService.creditDriverFare({
    driverId: payment.driver_id,
    tripId: payment.trip_id,
    pesos: credit,
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
