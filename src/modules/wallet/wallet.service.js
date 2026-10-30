const env = require("../../config/env");
const paymongo = require("./paymongo");
const walletRepo = require("./repositories/wallet.repository");
const AppError = require("../../utils/AppError");

/**
 * The driver's float.
 *
 * The owner's model, 26 Oct 2026: a driver pays money in, the passenger
 * settles the fare with the driver directly, and VeteRide's cut comes out
 * of the float when a ride completes.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE, both server-side because the app
 * is a copy anyone can edit:
 *
 *   - the amount is between PHP 100 (PayMongo's own floor for an e-wallet
 *     source) and PHP 3,000 (the owner's cap);
 *   - starting a top-up CREDITS NOTHING. The money becomes real in the
 *     webhook and nowhere else, because only PayMongo knows whether the
 *     driver actually paid.
 */

// The smallest top-up VeteRide asks for. Env-driven like MAX_TOPUP_PESOS so
// the owner can lower it for a live test - a real PHP 1 payment through a
// real wallet - and put it back without a deploy. Never below the gateway's
// own floor, whatever the env says.
const MIN_TOPUP = Math.max(
  paymongo.MIN_PESOS,
  Number(process.env.MIN_TOPUP_PESOS || 100),
);
const MAX_TOPUP = Number(process.env.MAX_TOPUP_PESOS || 3000);

/** Centavos, like every other money figure the app reads off this server. */
function toMinor(pesos) {
  return Math.round(Number(pesos || 0) * 100);
}

async function wallet(driverId) {
  const balance = await walletRepo.balanceOf(driverId);
  if (balance === null) throw new AppError(404, "NOT_FOUND", "No such driver");
  return {
    balance_minor: toMinor(balance),
    currency: "PHP",
    min_topup: MIN_TOPUP,
    max_topup: MAX_TOPUP,
    // What a driver must hold to go online. Named here so the app can warn
    // BEFORE the switch is refused rather than explaining a 403 afterwards.
    min_online: env.rides.minWalletToGoOnline,
    gateway: paymongo.enabled() ? "paymongo" : null,
    // Which wallets to offer, and how each is paid. Sent so the app renders
    // what this server can actually take instead of keeping its own list:
    // a build in a driver's pocket then follows a change here without being
    // reinstalled. Empty when no gateway is configured, so a screen with no
    // way to pay never draws a button.
    methods: paymongo.enabled() ? paymongo.enabledMethods() : [],
  };
}

async function ledger(driverId, limit) {
  const rows = await walletRepo.ledgerFor(driverId, limit);
  return rows.map((row) => ({
    id: row.entry_id,
    kind: row.kind,
    amount_minor: toMinor(row.amount),
    balance_after_minor: toMinor(row.balance_after),
    trip_id: row.trip_id,
    topup_id: row.topup_id,
    note: row.note,
    created_at: row.created_at,
  }));
}

/**
 * Opens a top-up and hands back where to pay.
 *
 * Nothing is credited here. The row is `pending` until PayMongo says
 * otherwise, and if the driver never pays it simply stays that way.
 */
async function startTopup({ driverId, amount, method, origin }) {
  if (!paymongo.enabled()) {
    throw new AppError(503, "NO_GATEWAY", "Top-up is not available right now.");
  }
  const pesos = Number(amount);
  if (!Number.isFinite(pesos) || pesos < MIN_TOPUP || pesos > MAX_TOPUP) {
    throw new AppError(
      400,
      "BAD_AMOUNT",
      `Top up between PHP ${MIN_TOPUP} and PHP ${MAX_TOPUP}.`,
    );
  }
  if (!paymongo.WALLETS.has(method)) {
    throw new AppError(400, "BAD_METHOD", `Unsupported payment method: ${method}`);
  }
  // Offered is not the same as supported. A method switched off for this
  // account must be refused here, in a 400 the app can read, rather than
  // sent to PayMongo to come back as a 502 that Cloudflare turns into
  // "error code: 502" and the driver reads as "Could not reach VeteRide".
  if (!paymongo.enabledMethods().some((m) => m.key === method)) {
    throw new AppError(
      400,
      "METHOD_UNAVAILABLE",
      "That way of paying is not switched on yet. Please pick another.",
    );
  }

  // Which of PayMongo's two flows this wallet needs. GCash and GrabPay are
  // Sources; Maya is Payment Intents and answers Sources with
  // "The source_type passed paymaya is invalid" — which is how every Maya
  // top-up used to become a 502.
  let gatewayRef = null;
  let checkoutUrl = null;
  let flow = "redirect";
  let qrImage = null;
  try {
    if (paymongo.INTENT_WALLETS.has(method)) {
      const started = await paymongo.startIntentCheckout({
        amount: pesos,
        type: method,
        returnUrl: `${origin}/wallet/topup-done?ok=1`,
      });
      gatewayRef = started.intentId;
      checkoutUrl = started.checkoutUrl;
      flow = started.flow;
      qrImage = started.qrImage;
    } else {
      const source = await paymongo.createSource({
        amount: pesos,
        type: method,
        successUrl: `${origin}/wallet/topup-done?ok=1`,
        failedUrl: `${origin}/wallet/topup-done?ok=0`,
      });
      gatewayRef = source?.data?.id || null;
      checkoutUrl = source?.data?.attributes?.redirect?.checkout_url || null;
    }
  } catch (error) {
    // The gateway's own sentence, not a stack trace: "the amount is below
    // the minimum" is something a driver can act on.
    //
    // A refusal (PayMongo answered 4xx) comes back as 400, not 502. Two
    // reasons: it is not a bad gateway - the gateway answered, clearly - and
    // a 5xx body is replaced by Cloudflare with its own error page, so the
    // explanation is lost exactly when somebody needs it. 4xx passes through.
    const refused = Number(error.status) >= 400 && Number(error.status) < 500;
    throw new AppError(
      refused ? 400 : 502,
      refused ? "GATEWAY_REFUSED" : "GATEWAY_ERROR",
      error.message,
    );
  }

  // A QR Ph top-up has no URL by design - the code is the checkout. So what
  // is required is a reference plus ONE of the two ways to pay.
  if (!gatewayRef || !(checkoutUrl || qrImage)) {
    throw new AppError(502, "GATEWAY_ERROR", "The payment gateway did not return a checkout.");
  }
  const sourceId = gatewayRef;

  const topup = await walletRepo.createTopup({
    driverId,
    amount: pesos,
    method,
    sourceRef: sourceId,
    checkoutUrl,
  });

  return {
    topup_id: topup.topup_id,
    amount_minor: toMinor(topup.amount),
    method: topup.method,
    status: topup.status,
    // Which of the two the app should do, said rather than inferred from
    // whether a field happens to be null.
    flow,
    checkout_url: checkoutUrl,
    // A PNG data URI for QR Ph, null for the rest. Not stored anywhere: it
    // is one code for one attempt, and a driver who closes the sheet starts
    // another rather than reusing a stale one.
    qr_image: qrImage,
  };
}

/**
 * A `source.chargeable` from PayMongo: the driver has authorised, so now
 * the money is actually taken and the balance credited.
 *
 * THE ONLY PLACE A BALANCE GOES UP. Safe to call twice — the repository's
 * transaction and the ledger's unique key make the second call a no-op —
 * which matters because PayMongo retries until it gets a 200.
 */
async function creditFromSource(sourceId) {
  const topup = await walletRepo.findTopupBySource(sourceId);
  if (!topup) return { handled: false };
  if (topup.status === "paid") return { handled: true, already: true };

  let paymentRef = null;
  try {
    const payment = await paymongo.createPaymentFromSource({
      sourceId,
      amount: topup.amount,
      description: `VeteRide wallet top-up ${topup.topup_id}`,
    });
    paymentRef = payment?.data?.id || null;
  } catch (error) {
    await walletRepo.markTopupFailed(topup.topup_id, error.message);
    return { handled: true, failed: true, reason: error.message };
  }

  const balance = await walletRepo.settleTopup({
    topupId: topup.topup_id,
    paymentRef,
  });
  return { handled: true, credited: balance !== null, balance_minor: toMinor(balance) };
}

/**
 * Maya's half: credit a top-up whose Payment Intent has been paid.
 *
 * NO createPaymentFrom… call here, unlike [creditFromSource]. An attached
 * intent collects the money itself, so by the time `payment.paid` arrives the
 * charge has already happened — taking it again would charge the driver
 * twice. All that is left is to write it down.
 *
 * Looked up by the intent id, which is what `startTopup` stored as the
 * top-up's gateway reference, so the same unique key makes a retried webhook
 * a no-op exactly as it does for a source.
 */
async function creditFromIntent({ intentId, paymentId }) {
  const topup = await walletRepo.findTopupBySource(intentId);
  if (!topup) return { handled: false };
  if (topup.status === "paid") return { handled: true, already: true };

  const balance = await walletRepo.settleTopup({
    topupId: topup.topup_id,
    paymentRef: paymentId || null,
  });
  return { handled: true, credited: balance !== null, balance_minor: toMinor(balance) };
}

/**
 * A Payment Intent that did not go through: Maya or QR Ph refused, expired,
 * or the driver backed out.
 *
 * Writes it down rather than leaving the row "pending" for ever. A top-up
 * stuck pending is not harmless - it is a driver looking at a screen that
 * says something is still on its way when nothing is.
 *
 * NEVER overrides a paid row. `payment.failed` can arrive after a retry has
 * already succeeded, and PayMongo gives no ordering guarantee; markTopupFailed
 * carries its own `status <> 'paid'` guard for exactly that reason. Money
 * that landed stays landed.
 */
async function failFromIntent({ intentId, reason }) {
  const topup = await walletRepo.findTopupBySource(intentId);
  if (!topup) return { handled: false };
  if (topup.status === "paid") return { handled: true, already: "paid" };
  await walletRepo.markTopupFailed(topup.topup_id, reason || "Payment failed");
  return { handled: true, failed: true };
}

/**
 * A fare the gateway collected, credited to the driver who earned it.
 *
 * The opposite direction from [chargeRideCommission], and the two are
 * mutually exclusive per ride: a cash fare takes 12% OUT of the float, a
 * gateway fare puts the other 88% IN. Taking both for one ride would charge
 * the driver twice, which is why trips.service.js forks before either.
 *
 * [pesos] is the driver's share, already less the platform's cut. This does
 * not recompute it: the split was worked out and written onto the receipt
 * when the charge was opened, and a number recomputed later can disagree
 * with the one the passenger was shown.
 */
async function creditDriverFare({ driverId, tripId, pesos }) {
  return walletRepo.creditFare({
    driverId,
    tripId,
    amount: pesos,
    note: "Fare paid in the app",
  });
}

/**
 * The platform's cut, taken when a ride completes.
 *
 * Off the FINAL fare, not the estimate at booking (owner, 26 Oct 2026):
 * the server re-prices from its own tariff, so a cut taken at booking would
 * need a refund when a ride is cancelled and a rebate whenever the fare
 * moved. Taken at the end, neither case exists.
 */
async function chargeRideCommission({ driverId, tripId, commissionPesos }) {
  return walletRepo.chargeCommission({
    driverId,
    tripId,
    amount: commissionPesos,
    note: `${env.rides.commissionPercent}% of the fare`,
  });
}

module.exports = {
  MIN_TOPUP,
  MAX_TOPUP,
  wallet,
  ledger,
  startTopup,
  creditFromSource,
  creditFromIntent,
  failFromIntent,
  chargeRideCommission,
  creditDriverFare,
};
