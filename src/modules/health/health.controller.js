const fs = require("fs");
const path = require("path");

/**
 * What this process is actually running.
 *
 * WHY THIS EXISTS. "Is X deployed?" has cost this project several days on
 * three separate occasions, and no answer from outside the box was ever
 * conclusive:
 *
 *   - GitHub only says what was merged. A merge is not a deploy here, and
 *     once main sat twelve hours ahead of the server for five days.
 *   - curl against a route proves nothing: `router.use(authenticate)` runs
 *     before route matching, so a real route, a missing route and an
 *     invented path all answer the same MISSING_TOKEN.
 *   - the app can tell you, but only with a signed-in handset in hand and
 *     a working connection.
 *
 * A commit is the whole answer. Given one, anybody can check on GitHub
 * whether the change they care about is in it.
 *
 * NOTHING SENSITIVE: a commit sha, a boot time and an uptime. No env, no
 * route list, no versions of anything that could be fingerprinted.
 */

// Resolved ONCE, at require time. Reading .git on every request would turn
// a liveness probe into disk I/O, and the answer cannot change without a
// restart anyway.
const commit = resolveCommit();
const startedAt = new Date().toISOString();

/**
 * The deployed commit, in the order most likely to be right.
 *
 * GIT_COMMIT first, for a container or a build that has no .git at all.
 * Otherwise read .git directly, which is what makes this work on this
 * server TODAY without anybody changing how they deploy: no export to
 * forget, no script to edit. A box that is pulled by hand still answers
 * correctly.
 */
function resolveCommit() {
  const fromEnv = (process.env.GIT_COMMIT || "").trim();
  if (fromEnv) return fromEnv.slice(0, 7);

  try {
    const gitDir = path.join(__dirname, "..", "..", "..", ".git");
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();

    // Detached HEAD holds the sha outright; otherwise it points at a ref.
    if (!head.startsWith("ref:")) return head.slice(0, 7);

    const ref = head.slice(4).trim();
    try {
      return fs.readFileSync(path.join(gitDir, ref), "utf8").trim().slice(0, 7);
    } catch {
      // A packed ref: .git/refs/<ref> does not exist as a file once git has
      // packed it, which it does on its own schedule. Fall back to the
      // packed-refs table rather than reporting unknown.
      const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
      for (const line of packed.split("\n")) {
        const [sha, name] = line.trim().split(/\s+/);
        if (name === ref && sha) return sha.slice(0, 7);
      }
      return "unknown";
    }
  } catch {
    // No .git and no GIT_COMMIT. Still answer 200 — this route's first job
    // is liveness, and a health check that fails because it cannot find a
    // commit is worse than one that says it does not know.
    return "unknown";
  }
}

exports.health = (req, res) =>
  res.status(200).json({
    status: "ok",
    commit,
    started_at: startedAt,
    uptime_s: Math.round(process.uptime()),
  });
