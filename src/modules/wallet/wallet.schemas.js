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

/**
 * What a driver may ask to take out.
 *
 * The bounds read MIN_PAYOUT and MAX_PAYOUT from the service for the same
 * reason the top-up schema does: a minimum advertised in the wallet reply
 * and a different one enforced here is a figure the app offers and the
 * server refuses.
 *
 * MIN_PAYOUT already has the fee floor applied, so this cannot accept an
 * amount that would pay the driver nothing.
 */
const requestPayoutSchema = z.object({
  // SHAPE ONLY. THE BOUNDS ARE THE SERVICE'S, deliberately, and this is the
  // one place the top-up pattern must not be copied.
  //
  // validateBody runs before the controller, so a bound here answers first
  // and answers with VALIDATION_ERROR - and the app's whole refusal design
  // turns on the code. AMOUNT_BELOW_MIN, INSUFFICIENT_BALANCE and
  // PAYOUT_PENDING all read as "it did not work" to a driver, and only one
  // of them is anybody's fault.
  //
  // It also prefixes the field name, so a driver on a handset was shown
  //
  //     amount: The smallest cash-out is PHP 500.
  //
  // The service throws AMOUNT_BELOW_MIN / AMOUNT_ABOVE_MAX with the same
  // sentence and no prefix, and it is just as server-side as this is.
  amount: z.coerce.number().finite().positive(),

  destination: z.enum(["gcash", "bank"]),

  // The DRIVER'S account, never ours. Loose on shape by design: a GCash
  // number and a bank account number look nothing alike, and a driver
  // refused for the formatting is a driver who cannot be paid.
  account_ref: z.string().trim().min(4).max(64),
  account_name: z.string().trim().min(1).max(120),

  // Generated once by the app when the cash-out sheet opens and reused by
  // every retry inside it. driver_payouts_idem_uk is what makes it mean
  // something; without it, two taps on a slow connection are two payouts.
  idempotency_key: z.string().uuid(),
});

const payoutListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = { startTopupSchema, requestPayoutSchema, payoutListQuerySchema };
