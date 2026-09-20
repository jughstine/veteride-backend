/**
 * The one message this server sends: six digits and what to do about them.
 *
 * Plain on purpose. No images, no tracking pixel, no click-through link, no
 * logo pulled from a CDN — a sign-in mail that loads remote content tells
 * whoever hosts that content when the account holder opened it, and a
 * sign-in mail with a link in it teaches people to click links in sign-in
 * mails, which is the whole of phishing. The code is read and typed; that
 * is all it is for.
 *
 * Both parts are built from the same words, so a client that shows text and
 * a client that shows HTML show the same thing.
 */

const APP_NAME = "VeteRide";

function minuteWord(minutes) {
  return minutes === 1 ? "minute" : "minutes";
}

function buildSignInCodeEmail({ code, ttlMinutes }) {
  const expiry = `${ttlMinutes} ${minuteWord(ttlMinutes)}`;

  const subject = `${code} is your ${APP_NAME} sign-in code`;

  const text = [
    `Your ${APP_NAME} sign-in code is:`,
    "",
    `    ${code}`,
    "",
    `It expires in ${expiry} and can be used once.`,
    "",
    `${APP_NAME} will never ask you for this code. If this was not you, ignore this e-mail — nobody can sign in without the code.`,
    "",
    APP_NAME,
  ].join("\n");

  // Inline styles only, and a <pre> for the digits: mail clients strip
  // <style> blocks, and a monospaced run is what makes 0 and O, 1 and l
  // readable when somebody is copying them across to a phone.
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;color:#111111;line-height:1.5">',
    `<p>Your ${APP_NAME} sign-in code is:</p>`,
    '<p style="font-family:\'Courier New\',Courier,monospace;font-size:40px;font-weight:bold;letter-spacing:8px;margin:24px 0">',
    escapeHtml(code),
    "</p>",
    `<p>It expires in ${escapeHtml(expiry)} and can be used once.</p>`,
    `<p style="color:#555555">${APP_NAME} will never ask you for this code. If this was not you, ignore this e-mail &mdash; nobody can sign in without the code.</p>`,
    `<p style="color:#555555">${APP_NAME}</p>`,
    "</div>",
  ].join("\n");

  return { subject, text, html };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = { buildSignInCodeEmail, APP_NAME };
