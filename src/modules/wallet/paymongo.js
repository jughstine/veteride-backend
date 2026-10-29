/**
 * PayMongo — GCash, Maya and GrabPay.
 *
 * SERVER-SIDE ONLY, and that is the whole reason this file exists rather
 * than the app calling PayMongo itself. The secret key authorises charges
 * and refunds; an APK is a zip file anyone can unpack. The phone asks this
 * server to start a payment, gets back a checkout URL, and the driver is
 * sent to the wallet from there.
 *
 * Configure with PAYMONGO_SECRET_KEY in the environment. Test keys begin
 * `sk_test_`, live keys `sk_live_`.
 *
 * TWO FLOWS, because PayMongo has two and the wallets are split across them.
 * This file used to claim GCash and Maya both went through Sources. They do
 * not: `POST /v1/sources` answers Maya with
 *
 *     400 parameter_invalid — The source_type passed paymaya is invalid.
 *
 * so every Maya top-up failed. Verified against the live API, 29 Oct 2026.
 *
 * SOURCES — gcash, grab_pay:
 *
 *   1. createSource()            -> a checkout_url the driver opens
 *   2. driver authorises in GCash / GrabPay
 *   3. PayMongo calls our webhook with `source.chargeable`
 *   4. createPaymentFromSource() actually takes the money
 *   5. `payment.paid` confirms it
 *
 * PAYMENT INTENTS — paymaya, qrph:
 *
 *   1. createPaymentIntent()     -> an intent and its client_key
 *   2. createPaymentMethod()     -> a paymaya or qrph method
 *   3. attach                    -> a next_action, and WHICH KIND DIFFERS
 *   4. driver authorises
 *   5. PayMongo calls our webhook with `payment.paid`
 *
 * Step 3 is the one that catches people. Maya answers
 * `next_action.type = "redirect"` with a URL to open. QR Ph answers
 * `next_action.type = "consume_qr"` with no URL at all — a PNG data URI the
 * driver has to SCAN, in `next_action.code.image_url`. Reading `.redirect.url`
 * for a QR Ph intent gets null, which is why the flow is named in the reply
 * rather than guessed at by the phone.
 *
 * Note what step 4-5 does NOT include: there is no createPaymentFrom… call.
 * An attached intent takes the money itself, so Maya credits on `payment.paid`
 * alone, and calling anything else would be a second charge.
 *
 * The webhook is why either flow is safe. A driver who authorises and then
 * closes the browser must still end up charged and credited, and the phone
 * must still find out — so the webhook, not the handset, is the source of
 * truth about whether money moved.
 */

const crypto = require("crypto");

const API = "https://api.paymongo.com/v1";

/**
 * Which flow each wallet goes through. Kept as two sets rather than one list
 * and an if: the split is PayMongo's and it is the thing that was got wrong.
 */
const SOURCE_WALLETS = new Set(["gcash", "grab_pay"]);
const INTENT_WALLETS = new Set(["paymaya", "qrph"]);

/** Every wallet this server will take, whichever flow it needs. */
const WALLETS = new Set([...SOURCE_WALLETS, ...INTENT_WALLETS]);

/** PayMongo's own floor for an e-wallet source: PHP 100.00. */
const MIN_PESOS = 100;

function secret() {
  return process.env.PAYMONGO_SECRET_KEY || "";
}

/** Whether a payment can be started at all. */
function enabled() {
  return secret().startsWith("sk_");
}

/**
 * Basic auth with the secret as the username and no password — PayMongo's
 * own scheme, not a bearer token.
 */
function authHeader() {
  return `Basic ${Buffer.from(`${secret()}:`).toString("base64")}`;
}

async function call(method, endpoint, body) {
  if (!enabled()) throw new Error("PayMongo is not configured");

  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify({ data: { attributes: body } }),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`PayMongo sent something that is not JSON (${response.status})`);
  }

  if (!response.ok) {
    // PayMongo returns an array of errors; the first one's detail is the
    // sentence worth repeating. Never the raw body — it echoes the request,
    // and the request carried the key.
    const detail = parsed?.errors?.[0]?.detail || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return parsed;
}

/**
 * Starts an e-wallet payment and returns the source, whose
 * `attributes.redirect.checkout_url` is where the driver goes.
 *
 * `amount` is in PESOS here and centavos on the wire; the conversion lives
 * at this edge so no caller has to hold the unit in their head.
 */
async function createSource({ amount, type, successUrl, failedUrl }) {
  // SOURCE_WALLETS, not WALLETS: handing Sources a `paymaya` is the bug
  // this set exists to make impossible.
  if (!SOURCE_WALLETS.has(type)) {
    throw new Error(`${type} does not use the Sources API`);
  }
  const centavos = Math.round(Number(amount) * 100);
  if (!Number.isFinite(centavos) || centavos < MIN_PESOS * 100) {
    throw new Error(`The smallest top-up this wallet accepts is PHP ${MIN_PESOS}.00`);
  }
  return call("POST", "/sources", {
    amount: centavos,
    currency: "PHP",
    type,
    redirect: { success: successUrl, failed: failedUrl },
  });
}

/** Takes the money, once a source has become chargeable. */
async function createPaymentFromSource({ sourceId, amount, description }) {
  return call("POST", "/payments", {
    amount: Math.round(Number(amount) * 100),
    currency: "PHP",
    description: description || "VeteRide wallet top-up",
    source: { id: sourceId, type: "source" },
  });
}

/**
 * Maya, in the three calls PayMongo requires.
 *
 * Returns `{ intentId, checkoutUrl }`. The intent id is what the webhook
 * will name later, so it is what gets stored against the top-up; the
 * checkout URL is where the driver goes.
 *
 * `returnUrl` is handed to PayMongo rather than kept here because PayMongo
 * appends its own query to it, and the page that catches it has to cope with
 * whatever arrives.
 */
async function startIntentCheckout({ amount, type, returnUrl }) {
  if (!INTENT_WALLETS.has(type)) {
    throw new Error(`${type} does not use Payment Intents`);
  }
  const centavos = Math.round(Number(amount) * 100);
  if (!Number.isFinite(centavos) || centavos < MIN_PESOS * 100) {
    throw new Error(`The smallest top-up this wallet accepts is PHP ${MIN_PESOS}.00`);
  }

  const intent = await call("POST", "/payment_intents", {
    amount: centavos,
    currency: "PHP",
    payment_method_allowed: [type],
    description: "VeteRide driver wallet top-up",
  });
  const intentId = intent?.data?.id;
  const clientKey = intent?.data?.attributes?.client_key;
  if (!intentId || !clientKey) throw new Error("PayMongo did not return a payment intent");

  const method = await call("POST", "/payment_methods", { type });
  const methodId = method?.data?.id;
  if (!methodId) throw new Error("PayMongo did not return a payment method");

  const attached = await call("POST", `/payment_intents/${intentId}/attach`, {
    payment_method: methodId,
    client_key: clientKey,
    return_url: returnUrl,
  });
  const action = attached?.data?.attributes?.next_action || {};
  const status = attached?.data?.attributes?.status || "unknown";

  if (action.type === "consume_qr") {
    // QR Ph. There is nowhere to send the driver - the PNG IS the checkout.
    const qrImage = action.code?.image_url || null;
    if (!qrImage) throw new Error(`QR Ph did not return a code (status ${status})`);
    return { intentId, flow: "qr", checkoutUrl: null, qrImage };
  }

  const checkoutUrl = action.redirect?.url || null;
  if (!checkoutUrl) {
    // An intent that attached with neither a redirect nor a QR is one the
    // driver has no way to pay: better a refusal now than a top-up row
    // nobody can finish.
    throw new Error(`${type} did not return a checkout (status ${status})`);
  }
  return { intentId, flow: "redirect", checkoutUrl, qrImage: null };
}

/**
 * Whether a webhook really came from PayMongo.
 *
 * The signature header is `t=<unix>,te=<hmac>,li=<hmac>` — `te` for test
 * mode, `li` for live. The HMAC is over `<t>.<raw body>` with the webhook
 * SECRET (not the API key), so the RAW bytes are required: parsing and
 * re-serialising the JSON changes them and every signature fails.
 *
 * A timestamp older than the tolerance is refused, so a captured webhook
 * cannot be replayed later to credit a wallet a second time.
 */
function verifyWebhook({ header, rawBody, toleranceSeconds = 300 }) {
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET || "";
  if (!webhookSecret) return { ok: false, reason: "no webhook secret configured" };
  if (!header) return { ok: false, reason: "no signature header" };

  const parts = Object.fromEntries(
    String(header)
      .split(",")
      .map((pair) => pair.split("=").map((s) => s.trim())),
  );
  const timestamp = parts.t;
  const signature = parts.te || parts.li;
  if (!timestamp || !signature) return { ok: false, reason: "malformed signature" };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) {
    return { ok: false, reason: "signature too old" };
  }

  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  // timingSafeEqual throws on a length mismatch, which is itself a tell, so
  // the lengths are compared first and the contents in constant time.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/**
 * What the app should offer, and how each one is paid.
 *
 * Here rather than in the phone: when a wallet is added or PayMongo drops
 * one, every build already out in the world follows without being rebuilt.
 * The app renders this list; it does not keep its own.
 */
const METHODS = [
  { key: "gcash", label: "GCash", flow: "redirect" },
  { key: "paymaya", label: "Maya", flow: "redirect" },
  { key: "qrph", label: "QR Ph", flow: "qr" },
];

module.exports = {
  WALLETS,
  METHODS,
  SOURCE_WALLETS,
  INTENT_WALLETS,
  MIN_PESOS,
  enabled,
  createSource,
  createPaymentFromSource,
  startIntentCheckout,
  verifyWebhook,
};
