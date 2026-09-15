const { Router } = require("express");
const { authenticate } = require("../middleware/authenticate");
const stream = require("./stream");

const router = Router();

/**
 * GET /stream — one long-lived connection per phone.
 *
 * Authenticated like everything else, and scoped to the caller: a stream
 * only ever carries events about the account that opened it.
 *
 * No `res.json` here and no `next()` afterwards — the response is left open
 * deliberately, and the error handler must never see it as an unanswered
 * request.
 */
router.get("/", authenticate, (req, res) => {
  // Express compression, if it is ever added, would buffer this into
  // silence. Stated here so a future middleware cannot break it quietly.
  req.socket.setNoDelay(true);
  req.socket.setTimeout(0);
  stream.open(res, req.user.id, req.user.role);
});

module.exports = router;
