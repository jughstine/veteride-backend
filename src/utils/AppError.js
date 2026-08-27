/**
 * Application-level error with an HTTP status and a stable machine-readable
 * code, so controllers never have to guess what a thrown error means.
 */
class AppError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

module.exports = AppError;
