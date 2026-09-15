/**
 * The ways a fare can be settled, and every spelling that reaches them.
 *
 * The first six are the app's own list (app/lib/data.dart, `PayKey`), in
 * its order; 'card' is here because this API's own PATCH /me/preferences
 * has stored it since before any of this existed, and a passenger whose
 * saved preference is a card must not have it quietly turned into cash.
 *
 * The fee schedule is NOT here. It is PayMongo's, it lives in the app
 * beside these names, and it applies to money a gateway carries — which
 * this API does not yet take. What the server records is what was chosen
 * and what was charged.
 */

/** The wire values. Anything outside this list is not a way to pay. */
const METHODS = [
  "cash",
  "gcash",
  "qrph",
  "ewallet",
  "unionbank",
  "instapay",
  "card",
];

const ALIASES = {
  cash: ["cash", "cod", "money"],
  gcash: ["gcash", "g-cash"],
  qrph: ["qrph", "qr", "qr-ph", "qrcode"],
  // Maya and ShopeePay are e-wallets under a name; 'maya' in particular is
  // what this API's own preferences column stores for one.
  ewallet: ["ewallet", "e-wallet", "wallet", "maya", "paymaya", "shopeepay", "grabpay"],
  unionbank: ["unionbank", "union-bank", "ub", "unionbank-online"],
  instapay: ["instapay", "bank", "bank-transfer", "pesonet"],
  card: ["card", "credit-card", "debit-card"],
};

/** alias -> method, built once rather than scanned per request. */
const BY_ALIAS = new Map();
for (const [method, spellings] of Object.entries(ALIASES)) {
  for (const spelling of spellings) BY_ALIAS.set(spelling, method);
}

/**
 * One method from whatever was written, or null.
 *
 * Separators settled first, the way vehicle-class.js does it, so "e wallet"
 * and "e_wallet" are the word they were typed as. Null rather than a
 * default: a booking that names a way to pay this server has not been
 * taught is refused, because silently recording it as cash is a receipt
 * that says the driver was handed money they never saw.
 */
function normalise(value) {
  if (value === null || value === undefined) return null;
  const word = String(value).trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!word) return null;
  return BY_ALIAS.get(word) || null;
}

/**
 * Whether settling this way needs a payment gateway.
 *
 * Cash is the only one of the seven that two people can complete between
 * themselves. Nothing reads this to charge anybody — there is no gateway
 * in this API — it is what the completion record consults to decide
 * whether it may claim a payment was confirmed. It never may, today.
 */
function needsGateway(method) {
  return normalise(method) !== "cash";
}

module.exports = { METHODS, normalise, needsGateway };
