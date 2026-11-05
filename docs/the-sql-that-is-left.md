# The SQL that is left, written against the real schema

Checked against `origin/main` at `88d961d`. Column names, the debit sign and
the transaction style are copied from
`src/modules/wallet/repositories/wallet.repository.js`, so these drop in
beside `settleTopup` and `chargeCommission` rather than beside a guess.

Both tables already exist: `014_payouts.sql` and `015_device_tokens.sql` are
on main and have been run.

What is **not** in `main` yet — `git grep -i payout src/` and
`git grep -i device_tokens src/` both return nothing — is any code that
reads or writes them. So the inserts below need a route and a controller
around them before the app can reach them.

---

## 1. Push token — `POST /me/push-token`

### The upsert

New file `src/modules/profile/repositories/device-token.repository.js`:

```js
const { randomUUID } = require("crypto");
const pool = require("../../../config/db");

/**
 * Keyed on the TOKEN alone, which is what the unique index in 015 is for.
 * A handset passed to another driver must MOVE to the new account rather
 * than ring for both — unique per user would leave the old row in place
 * and send that driver's offers to somebody else's phone.
 *
 * The app posts on every sign-in and every session restore, so this runs
 * often and has to be idempotent.
 */
async function saveToken({ userId, role, token, platform }) {
  await pool.query(
    `INSERT INTO device_tokens (token_id, user_id, role, token, platform)
     VALUES (:tokenId, :userId, :role, :token, :platform)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id), role = VALUES(role),
       platform = VALUES(platform), updated_at = CURRENT_TIMESTAMP`,
    {
      tokenId: randomUUID(),
      userId,
      role,
      token,
      platform: platform || "android",
    },
  );
}

/** Every phone that must ring for this account. Runs on every send. */
async function tokensFor(userId, role) {
  const [rows] = await pool.query(
    `SELECT token FROM device_tokens
      WHERE user_id = :userId AND role = :role`,
    { userId, role },
  );
  return rows.map((row) => row.token);
}

/**
 * FCM answered UNREGISTERED or NOT_FOUND: the app is gone from that
 * handset. Delete in the send path, right there — a table that only grows
 * means every notification costs more over time, and eventually most sends
 * go to phones that no longer exist.
 */
async function dropToken(token) {
  await pool.query(`DELETE FROM device_tokens WHERE token = :token`, { token });
}

module.exports = { saveToken, tokensFor, dropToken };
```

### The route — above the rider gate

`src/modules/profile/profile.routes.js`. This is the one trap: the file
gates its whole mount with `requireRole("rider")`, so a route appended in
the usual place **refuses every driver** — and drivers are who this is for.
The failure is quiet, a 403 the app swallows along with today's 404, so it
would look like nothing had changed.

```js
// BEFORE router.use(authenticate, requireRole("rider"))
//
// Both roles carry a phone, and the driver is the one who cannot work
// without this. Declared here so the rider gate below never sees it.
router.post(
  "/push-token",
  authenticate,
  validateBody(schemas.pushTokenSchema),
  controller.savePushToken,
);

router.use(authenticate, requireRole("rider"));   // existing line, stays
```

Express matches in declaration order, so a route declared before a
`router.use` never reaches it.

### The controller

```js
const savePushToken = asyncHandler(async (req, res) => {
  await deviceTokenRepo.saveToken({
    userId: req.user.id,
    role: req.user.role,          // req.user = { id, role }, authenticate.js:19
    token: req.body.token,
    platform: req.body.platform,
  });
  res.status(200).json({ ok: true });
});
```

`token` required and non-empty, `platform` one of `android`/`ios` defaulting
to `android`. The user comes from `req.user`, never the body — a token
addressed to an account the caller names is a way to receive somebody
else's rides.

---

## 2. Cash-out — `POST /drivers/me/payouts`

### The request: one transaction, three guards

New file `src/modules/wallet/repositories/payout.repository.js`:

```js
const { randomUUID } = require("crypto");
const pool = require("../../../config/db");

const PAYOUT_COLUMNS = `
  payout_id, driver_id, amount, fee, net_amount, status,
  destination, account_ref, account_name, provider_ref,
  failure_reason, requested_at, settled_at`;

/**
 * Debits the wallet and writes the row in ONE transaction.
 *
 * THE BALANCE GUARD IS IN THE UPDATE, not in JavaScript. chargeCommission
 * is debiting the same column from the ride that just finished, and a
 * SELECT followed by a check in JS loses that race. This direction cannot
 * be undone afterwards.
 */
async function requestPayout({
  driverId, amount, fee, destination, accountRef, accountName, idempotencyKey,
}) {
  const net = Math.round((Number(amount) - Number(fee)) * 100) / 100;
  const payoutId = randomUUID();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    // INSERT IGNORE against driver_payouts_idem_uk (driver_id,
    // idempotency_key). affectedRows = 0 is a RETRY, not a second request:
    // return the existing row with 200, not a 409. The app generates the
    // key once when the sheet opens and reuses it for every retry inside
    // it, so two taps on a slow connection are one payout.
    const [inserted] = await connection.query(
      `INSERT IGNORE INTO driver_payouts
         (payout_id, driver_id, amount, fee, net_amount, status,
          destination, account_ref, account_name, idempotency_key)
       VALUES (:payoutId, :driverId, :amount, :fee, :net, 'requested',
               :destination, :accountRef, :accountName, :idempotencyKey)`,
      { payoutId, driverId, amount, fee, net,
        destination, accountRef, accountName, idempotencyKey },
    );

    if (!inserted.affectedRows) {
      const [existing] = await connection.query(
        `SELECT ${PAYOUT_COLUMNS} FROM driver_payouts
          WHERE driver_id = :driverId AND idempotency_key = :idempotencyKey`,
        { driverId, idempotencyKey },
      );
      await connection.rollback();
      return { payout: existing[0], replayed: true };
    }

    // One in flight at a time, counted INSIDE the transaction and AFTER
    // our own insert — so the count includes this row, and > 1 means
    // somebody else's is already waiting. Two concurrent requests cannot
    // both pass this.
    const [pending] = await connection.query(
      `SELECT COUNT(*) AS n FROM driver_payouts
        WHERE driver_id = :driverId AND status = 'requested'`,
      { driverId },
    );
    if (Number(pending[0].n) > 1) {
      await connection.rollback();
      return { payout: null, reason: "PAYOUT_PENDING" };
    }

    // DEBIT ON REQUEST, not on settle. The guard is the WHERE clause.
    const [debit] = await connection.query(
      `UPDATE drivers SET wallet_balance = wallet_balance - :amount
        WHERE driver_id = :driverId AND wallet_balance >= :amount`,
      { driverId, amount },
    );
    if (!debit.affectedRows) {
      await connection.rollback();
      return { payout: null, reason: "INSUFFICIENT_BALANCE" };
    }

    const [after] = await connection.query(
      `SELECT wallet_balance FROM drivers WHERE driver_id = :driverId`,
      { driverId },
    );
    const balance = Number(after[0].wallet_balance);

    // NEGATIVE amount — the same convention chargeCommission uses for a
    // debit (`amount: -cut`). The unique key on payout_id makes a replay
    // a no-op.
    await connection.query(
      `INSERT IGNORE INTO wallet_ledger
         (entry_id, driver_id, kind, amount, balance_after, payout_id, note)
       VALUES (:entryId, :driverId, 'payout', :amount, :balance,
               :payoutId, :note)`,
      { entryId: randomUUID(), driverId, amount: -Number(amount),
        balance, payoutId, note: `Cash-out to ${destination}` },
    );

    const [rows] = await connection.query(
      `SELECT ${PAYOUT_COLUMNS} FROM driver_payouts
        WHERE payout_id = :payoutId`,
      { payoutId },
    );

    await connection.commit();
    return { payout: rows[0], balance };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
```

### The list

```js
async function listPayouts(driverId, limit) {
  const [rows] = await pool.query(
    `SELECT ${PAYOUT_COLUMNS} FROM driver_payouts
      WHERE driver_id = :driverId
      ORDER BY requested_at DESC
      LIMIT :limit`,
    { driverId, limit },
  );
  return rows;
}
```

### Admin settle

```js
async function settle({ payoutId, providerRef }) {
  const [result] = await pool.query(
    `UPDATE driver_payouts
        SET status = 'sent', provider_ref = :providerRef, settled_at = NOW()
      WHERE payout_id = :payoutId AND status = 'requested'`,
    { payoutId, providerRef: providerRef || null },
  );
  return result.affectedRows === 1;   // 0 = already settled or failed
}
```

### Admin fail — and it MUST credit back

```js
/**
 * The money did not leave. Credit it back in the SAME transaction as the
 * status change, or it leaves the driver's view without arriving anywhere
 * and only the ledger would know.
 */
async function fail({ payoutId, reason }) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // THE STATUS CHANGE IS THE GUARD. affectedRows = 0 means somebody
    // already settled or failed this one, and the credit below must not
    // run — otherwise a second call credits the driver twice.
    const [changed] = await connection.query(
      `UPDATE driver_payouts
          SET status = 'failed', failure_reason = :reason, settled_at = NOW()
        WHERE payout_id = :payoutId AND status = 'requested'`,
      { payoutId, reason: reason ? String(reason).slice(0, 255) : null },
    );
    if (!changed.affectedRows) {
      await connection.rollback();
      return false;
    }

    const [rows] = await connection.query(
      `SELECT driver_id, amount FROM driver_payouts
        WHERE payout_id = :payoutId`,
      { payoutId },
    );
    const { driver_id: driverId, amount } = rows[0];

    await connection.query(
      `UPDATE drivers SET wallet_balance = wallet_balance + :amount
        WHERE driver_id = :driverId`,
      { amount, driverId },
    );
    const [after] = await connection.query(
      `SELECT wallet_balance FROM drivers WHERE driver_id = :driverId`,
      { driverId },
    );

    // kind = 'adjustment' WITH NO payout_id, NOT kind = 'payout'.
    // wallet_ledger_payout_uk is UNIQUE on payout_id — one row per payout —
    // so a reversal written as ('payout', :payoutId) collides with the
    // debit row and the whole transaction fails.
    await connection.query(
      `INSERT INTO wallet_ledger
         (entry_id, driver_id, kind, amount, balance_after, note)
       VALUES (:entryId, :driverId, 'adjustment', :amount, :balance, :note)`,
      { entryId: randomUUID(), driverId, amount,
        balance: Number(after[0].wallet_balance),
        note: `Cash-out ${payoutId} failed` },
    );

    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
```

---

## 3. The three figures the app is waiting for

`src/modules/wallet/wallet.service.js`, beside `MIN_TOPUP`:

```js
const MIN_PAYOUT = Number(process.env.MIN_PAYOUT_PESOS || 500);
const MAX_PAYOUT = Number(process.env.MAX_PAYOUT_PESOS || 3000);
const PAYOUT_FEE = Number(process.env.PAYOUT_FEE_PESOS || 10);
```

and in `wallet()`'s return object, next to `min_topup`:

```js
    // THE MINIMUM MUST NEVER BE BELOW THE FEE. A payout at or under the
    // fee pays the driver nothing or less. Found on a handset with a test
    // build: at a PHP 1 minimum the screen offered "asking for PHP 1 pays
    // you -PHP 9". The app lifts its own floor to fee + 1, but an APK is
    // easy to edit and a server is not.
    min_payout: Math.max(MIN_PAYOUT, PAYOUT_FEE + 1),
    max_payout: MAX_PAYOUT,
    payout_fee: PAYOUT_FEE,
```

The app reads all three and only falls back to 500/3000/10 when they are
absent — so changing any of them later is a server-side change with no app
release, the same discipline as `TOPUP_METHODS`.

---

## 4. Routes

`src/modules/drivers/drivers.routes.js`, after the `/me/topups` block. The
file already has `router.use(authenticate, requireRole("driver"))` at the
top, so nothing else is needed:

```js
// Taking money back out — the opposite direction from /me/topups above.
// The driver is always req.user.id, never a path parameter, so one driver
// cannot cash out another's balance.
router.post(
  "/me/payouts",
  validateBody(walletSchemas.requestPayoutSchema),
  walletController.requestPayout,
);
router.get("/me/payouts", walletController.listPayouts);
```

---

## 5. The response the app parses

`driver_payouts` stores pesos as `DECIMAL(10,2)`; the app reads centavos,
like every other money figure on this server. `toMinor()` already exists in
`wallet.service.js`.

```js
function toPayoutJson(row) {
  return {
    payout_id: row.payout_id,
    amount_minor: toMinor(row.amount),
    fee_minor: toMinor(row.fee),
    net_amount_minor: toMinor(row.net_amount),
    status: row.status,                 // requested | sent | failed | cancelled
    destination: row.destination,
    account_ref: mask(row.account_ref), // last 4 only, in the reply AND in logs
    account_name: row.account_name,
    requested_at: row.requested_at,
    settled_at: row.settled_at,
    failure_reason: row.failure_reason,
  };
}
```

Refusal codes the app already names on screen, each needing its own:
`AMOUNT_BELOW_MIN`, `AMOUNT_ABOVE_MAX`, `INSUFFICIENT_BALANCE`,
`PAYOUT_PENDING`, `DAILY_LIMIT`.

And what it sends:

```json
{ "amount": 500, "destination": "gcash",
  "account_ref": "09171234567", "account_name": "Juan Dela Cruz",
  "idempotency_key": "<uuid v4>" }
```

`amount` is in **pesos**, not centavos — it goes straight into the
`DECIMAL(10,2)` column.
