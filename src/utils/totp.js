const crypto = require("crypto");
const env = require("../config/env");

/**
 * Time-based one-time passwords, RFC 6238, and the base32 spelling the
 * authenticator apps expect.
 *
 * WRITTEN OUT RATHER THAN INSTALLED, and deliberately: the whole of TOTP is
 * an HMAC, a counter and a modulo, all of which node's own crypto already
 * does. The popular packages for this are a few dozen lines around the same
 * three calls, and a dependency in the path of every sign-in is a dependency
 * whose next release can lock everybody out. Nothing here is invented — the
 * implementation is checked against RFC 6238's published test vectors.
 */

// RFC 4648 base32, which is what Google Authenticator reads. No padding: the
// apps accept it either way and a secret without '=' survives being typed by
// hand.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const raw of text.replace(/=+$/, "").toUpperCase()) {
    const index = B32.indexOf(raw);
    if (index === -1) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * A fresh secret: 20 random bytes, the length RFC 4226 recommends for
 * HMAC-SHA1, spelled in base32 for the person typing it in.
 */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * The six digits for one 30-second step. `counter` is unix time / 30.
 *
 * SHA1 is not a mistake here. TOTP's security rests on the secret and the
 * 30-second window, not on the digest's collision resistance, and every
 * authenticator app in the world assumes SHA1 — a stronger one would simply
 * not agree with the phone.
 */
function codeFor(secret, counter) {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const mac = crypto.createHmac("sha1", key).update(message).digest();
  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks
  // where in the digest to read from.
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Whether six typed digits are right for this secret, now.
 *
 * ONE STEP EITHER SIDE is allowed, which is 30 seconds of slack in each
 * direction. Phone clocks drift, and a code read out and typed at the turn of
 * a window is the commonest way an honest person is told they are wrong.
 * Wider than that starts to matter: every extra step is another live code.
 *
 * The comparison is constant-time. String equality returns at the first
 * character that differs, and the time it took to say no is a measurement of
 * how much was right.
 */
function verifyCode(secret, typed, { at = Date.now(), window = 1 } = {}) {
  if (typeof typed !== "string" || !/^[0-9]{6}$/.test(typed)) return false;
  const counter = Math.floor(at / 1000 / 30);
  const given = Buffer.from(typed, "utf8");

  let ok = false;
  for (let drift = -window; drift <= window; drift++) {
    const candidate = Buffer.from(codeFor(secret, counter + drift), "utf8");
    // Every step is checked even once one has matched: returning early would
    // leak which window it was, and the loop is three HMACs.
    if (crypto.timingSafeEqual(candidate, given)) ok = true;
  }
  return ok;
}

/**
 * The `otpauth://` URI a QR code carries.
 *
 * The label is what the person sees in their authenticator's list, so it
 * names VeteRide and the account: "VeteRide (juan@gmail.com)".
 */
function enrolmentUri({ secret, account }) {
  const issuer = encodeURIComponent("VeteRide");
  const label = `${issuer}:${encodeURIComponent(account)}`;
  return (
    `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}` +
    "&algorithm=SHA1&digits=6&period=30"
  );
}

/* ── The secret at rest ───────────────────────────────────────────────── */

/**
 * A key of this server's own, derived from the signing secret by domain
 * separation so it is NOT the JWT key itself.
 *
 * Why encrypt at all: a TOTP secret is a permanent credential. A leaked
 * password can be changed; a leaked secret generates valid codes for that
 * account until somebody notices and re-enrols. Anyone who can read a backup
 * of this table must not come away with a working second factor.
 */
const KEY = crypto
  .createHmac("sha256", env.jwt.accessSecret)
  .update("veteride/authenticator-secret/v1")
  .digest();

/** AES-256-GCM. Stored as iv:tag:ciphertext, all hex. */
function sealSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv.toString("hex"), cipher.getAuthTag().toString("hex"), body.toString("hex")].join(":");
}

/**
 * Back out again. Returns null rather than throwing on anything that does not
 * open — a row written under a different signing secret, or tampered with —
 * because the caller's answer to both is the same: this account has no
 * working second factor, ask them to enrol again.
 */
function openSecret(sealed) {
  try {
    const [iv, tag, body] = String(sealed).split(":");
    if (!iv || !tag || !body) return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      KEY,
      Buffer.from(iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

module.exports = {
  generateSecret,
  codeFor,
  verifyCode,
  enrolmentUri,
  sealSecret,
  openSecret,
  base32Encode,
  base32Decode,
};
