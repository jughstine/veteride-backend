/**
 * Application-level error with an HTTP status and a stable machine-readable
 * code, so controllers never have to guess what a thrown error means.
 *
 * `details` is the refusal's evidence, merged into the response body beside
 * the error. Four call sites in trips.service.js were already passing it —
 * the trip a 409 refers to — and it was being dropped on the floor here,
 * which is what turned "you already have a ride in progress" into "another
 * driver took this ride" on the driver's screen: with no trip in the body
 * the app cannot tell the two 409s apart, and classifies the refusal as a
 * lost race.
 */
class AppError extends Error {
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
  }
}

module.exports = AppError;
