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
        const outcome = await walletService.creditFromSource(resource.id);
        logger.info?.(`paymongo source.chargeable ${resource.id}: ${JSON.stringify(outcome)}`);
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
