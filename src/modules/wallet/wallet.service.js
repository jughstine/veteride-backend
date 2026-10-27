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

const MIN_TOPUP = paymongo.MIN_PESOS;      // 100
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

  let source;
  try {
    source = await paymongo.createSource({
      amount: pesos,
      type: method,
      successUrl: `${origin}/wallet/topup-done?ok=1`,
      failedUrl: `${origin}/wallet/topup-done?ok=0`,
    });
  } catch (error) {
    // The gateway's own sentence, not a stack trace: "the amount is below
    // the minimum" is something a driver can act on.
    throw new AppError(502, "GATEWAY_ERROR", error.message);
  }

  const sourceId = source?.data?.id || null;
  const checkoutUrl = source?.data?.attributes?.redirect?.checkout_url || null;
  if (!sourceId || !checkoutUrl) {
    throw new AppError(502, "GATEWAY_ERROR", "The payment gateway did not return a checkout.");
  }

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
    checkout_url: checkoutUrl,
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
  chargeRideCommission,
};
