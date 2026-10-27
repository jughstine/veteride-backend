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
 * THE FLOW, for e-wallets (the Sources API, which is what GCash and Maya
 * use — not Payment Intents):
 *
 *   1. createSource()            -> a checkout_url the driver opens
 *   2. driver authorises in GCash / Maya
 *   3. PayMongo calls our webhook with `source.chargeable`
 *   4. createPaymentFromSource() actually takes the money
 *   5. `payment.paid` confirms it
 *
 * Steps 3-5 are why the webhook exists. A driver who authorises and then
 * closes the browser must still end up charged and credited, and the phone
 * must still find out — so the webhook, not the handset, is the source of
 * truth about whether money moved.
 */

const crypto = require("crypto");

const API = "https://api.paymongo.com/v1";

/** The wallets this server will start a source for. */
const WALLETS = new Set(["gcash", "paymaya", "grab_pay"]);

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
  if (!WALLETS.has(type)) throw new Error(`Unsupported wallet: ${type}`);
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

module.exports = {
  WALLETS,
  MIN_PESOS,
  enabled,
  createSource,
  createPaymentFromSource,
  verifyWebhook,
};
