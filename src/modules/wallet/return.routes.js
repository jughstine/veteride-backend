const { Router } = require("express");

/**
 * Where PayMongo sends the driver's browser after they pay, or don't.
 *
 * `wallet.service.js` has always pointed `redirect.success` and
 * `redirect.failed` at `/wallet/topup-done`, and nothing has ever served it.
 * So a driver who finished paying in GCash landed on the API's own 404 —
 * `{"error":{"code":"NOT_FOUND","message":"Route not found"}}` — rendered as
 * raw JSON by Chrome. The money was fine; the last thing they saw said
 * otherwise. Verified on a real test payment, 29 Oct 2026.
 *
 * WHAT THIS PAGE MUST NOT DO is tell anyone their balance went up. It is the
 * browser coming back from a redirect, and `?ok=1` only means PayMongo
 * thought the authorisation went through — the balance moves when the webhook
 * arrives, which may be a second later or, on a failed delivery, not yet. So
 * the page says the payment was sent and the app will show the balance once
 * VeteRide has confirmed it. The app polls and says the same thing.
 *
 * Plain HTML, no JavaScript and no assets: it is opened in whatever browser
 * the phone has, on a connection that just proved itself slow enough for the
 * driver to be staring at it.
 */
const router = Router();

/** Escapes nothing by design — nothing here comes from the request. */
function page({ heading, body, tone }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VeteRide</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #f6f7f9; color: #10151c; padding: 24px;
         font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  @media (prefers-color-scheme: dark) {
    body { background: #0e1116; color: #e8ecf1; }
    .card { background: #161b22 !important; border-color: #2a313a !important; }
    .muted { color: #9aa6b2 !important; }
  }
  .card { background: #fff; border: 1px solid #e3e7ec; border-radius: 18px;
          padding: 28px 24px; max-width: 420px; width: 100%; text-align: center; }
  .dot { width: 54px; height: 54px; border-radius: 50%; margin: 0 auto 18px;
         display: grid; place-items: center; font-size: 26px; color: #fff;
         background: ${tone === "ok" ? "#16a42a" : "#c2410c"}; }
  h1 { font-size: 20px; margin: 0 0 10px; letter-spacing: -0.3px; }
  p { margin: 0 0 14px; }
  .muted { color: #5b6672; font-size: 14px; }
</style>
</head>
<body>
  <main class="card">
    <div class="dot">${tone === "ok" ? "&#10003;" : "!"}</div>
    <h1>${heading}</h1>
    ${body}
    <p class="muted">You can close this page and go back to VeteRide.</p>
  </main>
</body>
</html>`;
}

router.get("/topup-done", (req, res) => {
  const ok = String(req.query.ok ?? "") === "1";
  res.type("html").send(
    ok
      ? page({
          tone: "ok",
          heading: "Payment sent",
          // Not "topped up", and not an amount. See the note above: this
          // request is the browser returning, not the payment confirming.
          body:
            "<p>VeteRide is confirming it with your e-wallet now. Your balance " +
            "updates in the app as soon as that comes back &mdash; usually a " +
            "few seconds.</p>",
        })
      : page({
          tone: "bad",
          heading: "Payment not completed",
          body:
            "<p>Nothing has been charged. You can start the top-up again from " +
            "the Wallet screen in VeteRide.</p>",
        }),
  );
});

module.exports = router;
