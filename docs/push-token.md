# Push tokens, and the route that stores them

`migrations/015_device_tokens.sql` in this PR is the table. This is the
contract the app already calls.

## Why this is the most urgent thing outstanding

A driver whose app is not open and in front **receives nothing**. No booking
offer, no sound, nothing.

Both existing paths need the app running:

- the offer poll, armed when the driver goes on duty
- the SSE stream in `src/realtime/stream.js`

Phone in a pocket, screen off, or the app swiped away — silence. For a
ride-hailing app that is not a missing feature, it is the product not
working. This table and one route are the whole fix.

The app side has been live for some time: Firebase registers correctly and
the handset produces an id. It posts that id to `POST /me/push-token`, gets
a 404, and swallows it by design — there is nothing a driver could do about
it. **The day this ships, every handset already installed starts
registering. No new APK.**

## The trap: `/me` is rider-only

`profile.routes.js` gates its whole mount:

```js
router.use(authenticate, requireRole("rider"));
```

So a route appended to that file in the usual place **refuses every
driver** — and drivers are exactly who this is for. The failure is quiet:
a 403 the app swallows along with the 404, so it would look like nothing
had changed.

Register it **above** the gate, where only `authenticate` has run:

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

router.use(authenticate, requireRole("rider"));
```

Express matches in declaration order, so a route declared before a
`router.use` never reaches it.

## The route

```
POST /me/push-token
{ "token": "d1lJ93NWQHefEOj4F_B0ST", "platform": "android" }
```

`token` is required and non-empty; `platform` is `android` or `ios` and
defaults to `android`. The user comes from `req.user`, never the body — a
token addressed to an account the caller names is a way to receive somebody
else's rides.

One upsert, keyed on the token alone:

```sql
INSERT INTO device_tokens (token_id, user_id, role, token, platform)
VALUES (:tokenId, :userId, :role, :token, :platform)
ON DUPLICATE KEY UPDATE
  user_id = VALUES(user_id), role = VALUES(role),
  platform = VALUES(platform), updated_at = CURRENT_TIMESTAMP;
```

The app posts on every sign-in and every session restore, so this runs
often and must be idempotent. `200` either way; the app does not read the
body.

## Deleting dead tokens is not optional

When FCM answers `UNREGISTERED` or `NOT_FOUND` for a token, that handset has
uninstalled the app or cleared its data. **Delete the row** in the send
path, right there.

A table that only grows means every notification costs more over time, and
eventually most sends go to phones that no longer exist — slowly, so nobody
notices until the bill or the latency does.

## Sending

FCM's legacy API was switched off in June 2024. HTTP v1 and an OAuth2
service account are the only way now.

The service-account JSON is a credential with the same handling as a live
payment key: **never in the repo**, never in a chat, never in a log.

Payload shape that matters:

```json
{
  "message": {
    "token": "<from device_tokens>",
    "notification": { "title": "New booking", "body": "..." },
    "data": { "trip_id": "..." },
    "android": { "priority": "high",
                 "notification": { "channel_id": "veteride_rides" } }
  }
}
```

Three things in there are not optional:

- **`notification` AND `data` together.** A `data`-only message is often
  dropped to a stopped app. With a `notification` block Android draws the
  card itself whether the app is running or not.
- **`"priority": "high"`**, or the phone will not be woken out of Doze.
- **`channel_id` exactly `veteride_rides`.** Android **silently drops** a
  notification aimed at a channel that does not exist — no error, nothing on
  screen. The app creates that channel at startup. If messages stop arriving
  after somebody renames it, that is where to look.

## What this still cannot do

Reach a **force-stopped** app. Android delivers nothing to one, by design,
and the battery managers on vivo, Xiaomi, Oppo and Infinix force-stop
background apps on their own schedule. That is a handset setting, not a bug
here — worth telling drivers once at sign-up rather than debugging per
phone.
