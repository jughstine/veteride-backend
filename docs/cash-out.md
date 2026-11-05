# Driver cash-out

The driver asks for money out of their wallet, the wallet is debited there
and then, and the transfer is made afterwards — by hand at first, through
PayMongo later.

`migrations/014_payouts.sql` in this PR is the schema. This is the contract
the app already calls.

## Why this is not optional

`012_wallet.sql` was written for a prepaid float: money the driver paid in,
that only ever went down as commission came out.

With PR #17 the wallet also receives the driver's **earnings** — 88% of
every gateway-paid fare. So the balance is now money we owe, and it grows
with every ride. A driver who cannot withdraw it has not been paid.

Cash-out is payroll, not a feature.

## The figures

Owner's decision, 4 Nov 2026:

| | |
|---|---|
| Minimum | PHP 500 |
| Maximum per request | PHP 3,000 |
| Fee | PHP 10, borne by the **driver**, deducted from the payout |

Please serve all three from `GET /drivers/me/wallet` as `min_payout`,
`max_payout` and `payout_fee`. The app reads them and falls back to
500/3000/10 only when they are absent — so changing any of them later is a
server-side change with **no app release**, the same discipline as
`TOPUP_METHODS`.

## Routes

### `POST /drivers/me/payouts`

```json
{ "amount": 500,
  "destination": "gcash",
  "account_ref": "09171234567",
  "account_name": "Juan Dela Cruz",
  "idempotency_key": "<uuid v4 from the app>" }
```

Answers the created payout. Refusals, each with its own code so the app can
say which: `AMOUNT_BELOW_MIN`, `AMOUNT_ABOVE_MAX`, `INSUFFICIENT_BALANCE`,
`PAYOUT_PENDING` (one in flight at a time), `DAILY_LIMIT`.

### `GET /drivers/me/payouts?limit=20`

Newest first: `payout_id`, `amount_minor`, `fee_minor`, `net_amount_minor`,
`status`, `destination`, a **masked** `account_ref`, `requested_at`,
`settled_at`, `failure_reason`.

### Admin

- `GET /admin/payouts?status=requested`
- `POST /admin/payouts/:id/settle` — `{ provider_ref }` → `sent`
- `POST /admin/payouts/:id/fail` — `{ reason }` → `failed`, **and credits
  the wallet back**

## Four things worth not shortcutting

This direction cannot be undone, so each of these is the difference between
an annoyance and money that is actually gone.

**1. Debit the wallet when the payout is REQUESTED**, not when it settles,
inside the same transaction that writes the row — and put the guard in the
UPDATE, not in JavaScript:

```sql
UPDATE drivers SET wallet_balance = wallet_balance - :amount
 WHERE driver_id = :driverId AND wallet_balance >= :amount
```

`affectedRows = 0` means insufficient balance; roll back. A `SELECT` and a
balance check in JS before the UPDATE loses the race against
`chargeCommission`, which is debiting the same column from the ride that
just finished.

**2. `INSERT IGNORE` against `driver_payouts_idem_uk (driver_id,
idempotency_key)`.** When `affectedRows = 0`, return the **existing** payout
with **200**, not a 409 — that is a retry, not a second request. The app
generates the key once when the sheet opens and reuses it for every retry
inside it, so two taps on a slow connection are one payout.

**3. `fail` must credit the wallet back**, in the same transaction as the
status change. Otherwise the money leaves the driver's view without arriving
anywhere, and only the ledger would know.

**4. The minimum must never be below the fee.** A payout at or under PHP 10
pays the driver nothing or less. This was found on a handset with a test
build: at a PHP 1 minimum the screen offered "asking for PHP 1 pays you
-PHP 9". The app now lifts its own floor to `fee + 1`, but please enforce it
here too — an APK is easy to edit, a server is not.

## Two phases

**Phase 1 — settle by hand.** No new PayMongo product needed. The driver
requests, the wallet debits, the queue appears in admin, the owner sends the
money and marks it settled. Everything above is needed for this and nothing
more.

**Phase 2 — automatic.** The same routes, with the settle step calling
PayMongo's Treasury / Send Money API and storing the transfer id in
`provider_ref`. **The app does not change at all**, which is why phase 1 is
written with the full table rather than a shortcut.

## The app side is already live

Shipped ahead of this on purpose, the same way the push token was.

The app already calls `POST /drivers/me/payouts`. Today it answers 404 and
the sheet says "Cash-out is not switched on yet. Nothing has been taken from
your balance." **The day this merges and deploys, every handset already
installed starts working — no new APK.**

It sends `idempotency_key` on every request. The unique index in the
migration is what makes that mean something.

## One for the owner, not for this repo

Under this model VeteRide collects passengers' money and pays it out to
third parties. PayMongo will have its own requirements for that, and there
may be BSP ones. Worth settling before drivers are recruited.
