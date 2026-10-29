const { Router } = require("express");
const express = require("express");
const paymongo = require("./paymongo");
const walletService = require("./wallet.service");
const logger = require("../../utils/logger");

/**
 * PayMongo's callback. The only place a wallet balance may go up.
 *
 * MOUNTED BEFORE express.json(), with express.raw(), because the signature
 * is an HMAC over the RAW bytes. Parsing the JSON and re-serialising it
 * changes them — key order, spacing — and every signature then fails for a
 * reason that looks nothing like its cause.
 *
 * NO authenticate() in front of it: the caller is PayMongo, which has no
 * VeteRide session. The signature IS the authentication, and without a
 * configured webhook secret this route refuses everything rather than
 * trusting a body that anyone could post.
 *
 * It answers 200 to anything it has decided about, including events it does
 * not act on. A non-200 makes PayMongo retry, and retrying an event we
 * deliberately ignored is a queue that never drains.
 */
const router = Router();

router.post(
  "/paymongo",
  express.raw({ type: "*/*", limit: "1mb" }),
  async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : String(req.body || "");

    const check = paymongo.verifyWebhook({
      header: req.headers["paymongo-signature"],
      rawBody: raw,
    });
    if (!check.ok) {
      logger.warn?.(`paymongo webhook rejected: ${check.reason}`);
      return res.status(401).json({ error: { code: "BAD_SIGNATURE", message: check.reason } });
    }

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: { code: "BAD_JSON", message: "Unreadable body" } });
    }

    const type = event?.data?.attributes?.type;
    const resource = event?.data?.attributes?.data;

    try {
      if (type === "source.chargeable" && resource?.id) {
        // GCash and GrabPay. The source is authorised; the charge is ours to
        // make, and creditFromSource makes it.
        const outcome = await walletService.creditFromSource(resource.id);
        logger.info?.(`paymongo source.chargeable ${resource.id}: ${JSON.stringify(outcome)}`);
      } else if (type === "payment.paid") {
        // Maya. A Payment Intent has already collected the money, so there
        // is nothing to charge - only a balance to move. The intent id is
        // what the top-up was stored against, and PayMongo puts it on the
        // payment rather than at the top of the event.
        const intentId =
          resource?.attributes?.payment_intent_id ||
          resource?.attributes?.data?.payment_intent_id ||
          null;
        if (intentId) {
          const outcome = await walletService.creditFromIntent({
            intentId,
            paymentId: resource.id || null,
          });
          logger.info?.(`paymongo payment.paid ${intentId}: ${JSON.stringify(outcome)}`);
        } else {
          // A GCash payment.paid also lands here: it is the confirmation of
          // the charge creditFromSource already made, and carries no intent.
          // Nothing to do, and nothing wrong.
          logger.info?.(`paymongo payment.paid with no intent (${resource?.id}) ignored`);
        }
      } else if (type === "payment.failed") {
        const intentId = resource?.attributes?.payment_intent_id || null;
        logger.warn?.(`paymongo payment.failed ${intentId || resource?.id}`);
      }
    } catch (error) {
      // Logged and swallowed: a 500 here makes PayMongo retry, and the
      // retry hits the same fault. The top-up stays unpaid, which is a
      // state somebody can see and fix, rather than a loop nobody can.
      logger.error?.(`paymongo webhook failed: ${error.message}`);
    }

    return res.status(200).json({ received: true });
  },
);

module.exports = router;
