/**
 * Server-Sent Events: the phones stop asking, and get told instead.
 *
 * Without this both apps must poll — the passenger for their ride, the
 * driver for their ride and again for the open list. Two phones is ninety
 * requests a minute to learn, almost always, that nothing has changed, and
 * the news still arrives up to a poll late, which on a screen showing "your
 * driver has accepted" is exactly where the delay is felt.
 *
 * SSE is one long-lived GET per phone. Plain HTTP, so it survives every
 * proxy and tunnel in the way, needs no dependency, and reconnects itself —
 * which a WebSocket would not do for free.
 *
 * What it deliberately is NOT is a source of truth. Every event carries only
 * "something of yours changed"; the phone then reads the REST endpoint it
 * already read. A dropped event therefore costs latency and never
 * correctness, which is what lets the client keep a slow poll underneath as
 * a net.
 */

/** account id -> the open responses for it. One account may hold several. */
const subscribers = new Map();

/** account id -> role, so a booking can be announced to drivers only. */
const roles = new Map();

/**
 * A comment line every 20 seconds.
 *
 * An idle SSE connection is indistinguishable from a dead one to every proxy
 * between here and the handset, and most will close what they believe is
 * idle. A colon-prefixed line is ignored by the client and resets every
 * timer in the path.
 */
const HEARTBEAT_MS = 20_000;

/** Opens a stream for one account. Returns the function that closes it. */
function open(res, accountId, role) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Nginx and friends buffer by default, which holds events until the
    // buffer fills — for a stream that sends forty bytes a minute, for ever.
    "x-accel-buffering": "no",
  });

  // Tells the client how long to wait before reconnecting, and gives it
  // something to parse at once rather than waiting for the first real event.
  res.write("retry: 3000\n");
  res.write('event: ready\ndata: {"ok":true}\n\n');

  roles.set(accountId, role);
  let set = subscribers.get(accountId);
  if (!set) {
    set = new Set();
    subscribers.set(accountId, set);
  }
  set.add(res);

  const beat = setInterval(() => {
    // Writing to a socket the client already dropped throws rather than
    // returning false, and the close handler is not always first.
    try {
      res.write(": beat\n\n");
    } catch {
      close();
    }
  }, HEARTBEAT_MS);

  function close() {
    clearInterval(beat);
    const live = subscribers.get(accountId);
    if (!live) return;
    live.delete(res);
    if (live.size === 0) {
      subscribers.delete(accountId);
      roles.delete(accountId);
    }
  }

  res.on("close", close);
  res.on("error", close);
  return close;
}

/** Tells these accounts that something of theirs moved. */
function notify(accountIds, event, data = {}) {
  const payload = JSON.stringify(data);
  for (const id of new Set((accountIds || []).filter(Boolean))) {
    const set = subscribers.get(id);
    if (!set) continue;
    for (const res of [...set]) {
      try {
        res.write(`event: ${event}\ndata: ${payload}\n\n`);
      } catch {
        set.delete(res);
      }
    }
  }
}

/**
 * Every driver holding a stream, for a booking nobody owns yet.
 *
 * Deliberately not filtered by distance. The event carries no ride — it says
 * only "the open list changed" — and the phone answers by re-reading
 * GET /trips/open, which is the query that already applies the radius.
 * Putting the radius in two places is how the two stop agreeing.
 */
function notifyDrivers(event, data = {}) {
  const drivers = [...roles.entries()]
    .filter(([, role]) => role === "driver")
    .map(([id]) => id);
  notify(drivers, event, data);
}

/** How many phones are listening, for the health endpoint. */
function connectionCount() {
  let total = 0;
  for (const set of subscribers.values()) total += set.size;
  return total;
}

module.exports = { open, notify, notifyDrivers, connectionCount };
