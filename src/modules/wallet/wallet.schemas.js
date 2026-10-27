const { z } = require("zod");

/**
 * What a driver may ask to put in.
 *
 * The bounds are repeated in wallet.service.js and that is deliberate: this
 * one rejects the shape, that one rejects the amount against the live
 * configuration, and a cap enforced only at the edge is a cap anyone
 * holding a copy of the app can edit out. The app checks too, for a
 * message before the request, not instead of it.
 */
const startTopupSchema = z.object({
  // Coerced, because a phone will send `500` and a form will send "500",
  // and a top-up refused for the quoting is a driver who cannot pay.
  amount: z.coerce
    .number()
    .finite()
    .min(100, "The smallest top-up is PHP 100.")
    .max(3000, "The largest single top-up is PHP 3,000."),

  // The three e-wallets PayMongo's Sources API carries. Cards go through a
  // different PayMongo flow entirely and are not offered here yet.
  method: z.enum(["gcash", "paymaya", "grab_pay"]),
});

module.exports = { startTopupSchema };
