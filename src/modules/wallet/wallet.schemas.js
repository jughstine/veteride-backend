const { z } = require("zod");
const { MIN_TOPUP, MAX_TOPUP } = require("./wallet.service");

/**
 * What a driver may ask to put in.
 *
 * The bounds are checked twice and that is deliberate: this one rejects the
 * shape, wallet.service.js rejects the amount against the live
 * configuration, and a cap enforced only at the edge is a cap anyone holding
 * a copy of the app can edit out. The app checks too, for a message before
 * the request rather than instead of it.
 *
 * WHAT THEY MUST NOT BE IS TWO DIFFERENT NUMBERS. These were literals, 100
 * and 3000, written when the service's were literals too. Once MIN_TOPUP
 * became MIN_TOPUP_PESOS the server started advertising `min_topup: 1` in
 * the wallet reply and then refusing PHP 1 here - a minimum the app showed,
 * offered a chip for, and could not spend. Both ends now read the one
 * source, so they cannot drift again.
 */
const startTopupSchema = z.object({
  // Coerced, because a phone will send `500` and a form will send "500",
  // and a top-up refused for the quoting is a driver who cannot pay.
  amount: z.coerce
    .number()
    .finite()
    .min(MIN_TOPUP, `The smallest top-up is PHP ${MIN_TOPUP.toLocaleString("en-PH")}.`)
    .max(MAX_TOPUP, `The largest single top-up is PHP ${MAX_TOPUP.toLocaleString("en-PH")}.`),

  // Every wallet this server knows how to start, across both PayMongo flows
  // - gcash and grab_pay through Sources, paymaya and qrph through Payment
  // Intents. Which of them a DRIVER is offered is a narrower question, and
  // the service answers it against what this account can actually take.
  method: z.enum(["gcash", "paymaya", "grab_pay", "qrph"]),
});

module.exports = { startTopupSchema };
