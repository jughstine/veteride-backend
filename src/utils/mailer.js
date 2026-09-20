const nodemailer = require("nodemailer");
const env = require("../config/env");
const logger = require("./logger");

/**
 * The one place this server puts mail on the wire.
 *
 * Everything it needs comes from the environment — SMTP_HOST, SMTP_PORT,
 * SMTP_USER, SMTP_PASS, MAIL_FROM — and NONE of it has a default. A default
 * here would be a guess about somebody's mail server, and a wrong guess is a
 * sign-in code posted to a stranger. Absent settings mean absent settings:
 * `isConfigured()` answers false, the server still boots, and the one route
 * that sends mail refuses with a 503 that names the problem instead of
 * throwing an ECONNREFUSED out of a request handler.
 */

let transporter = null;

/**
 * Host, port and a From address are the minimum for a message to leave.
 *
 * Username and password are NOT in that minimum on purpose: Gmail needs
 * them, and a relay on localhost does not, so an unauthenticated relay is a
 * valid configuration rather than a broken one.
 */
function isConfigured() {
  return Boolean(env.mail.host && env.mail.port && env.mail.from);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    // 465 is SMTP-over-TLS from the first byte; 587 and everything else
    // start in the clear and raise STARTTLS, which nodemailer does on its
    // own when the server offers it.
    secure: env.mail.port === 465,
    // No credentials configured -> connect without AUTH rather than send an
    // empty username, which most relays answer with a 535 and a lockout.
    auth:
      env.mail.user && env.mail.pass
        ? { user: env.mail.user, pass: env.mail.pass }
        : undefined,
  });

  return transporter;
}

/**
 * Sends one message. Resolves to the provider's id; throws whatever the
 * transport threw, for the caller to decide about.
 *
 * NOTE WHAT IS NOT LOGGED: not `text`, not `html`, and NOT `subject`. The
 * only mail this server sends is a sign-in code, and that code is in the
 * subject line as well as the body -- it is put there so a phone can show it
 * on the lock screen, which means a log line carrying the subject is a log
 * file full of live sign-in codes. The message id is enough to trace a
 * delivery with the relay.
 */
async function sendMail({ to, subject, text, html }) {
  const tx = getTransporter();
  if (!tx) {
    throw new Error("SMTP is not configured");
  }

  const info = await tx.sendMail({
    from: env.mail.from,
    to,
    subject,
    text,
    html,
  });

  logger.info("Mail sent", { messageId: info.messageId });
  return info;
}

/** Test seam: forget the cached transport so new env values are picked up. */
function resetTransporter() {
  transporter = null;
}

module.exports = { isConfigured, sendMail, resetTransporter };
