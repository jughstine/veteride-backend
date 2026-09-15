const AppError = require("../utils/AppError");
const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    // The details go beside the error rather than inside it, because what
    // they carry is a resource the client already knows how to read: a 409
    // that refuses an accept hands back the trip this driver is actually
    // on, and the app adopts it from the same `trip` key every successful
    // reply uses. `error` is written last so a detail can never overwrite
    // the reason for the refusal.
    return res.status(err.statusCode).json({
      ...(err.details || {}),
      error: { code: err.code, message: err.message },
    });
  }

  if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
    return res.status(401).json({
      error: {
        code: "INVALID_TOKEN",
        message: "Access token is invalid or expired",
      },
    });
  }

  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      error: { code: "DUPLICATE_ENTRY", message: "Resource already exists" },
    });
  }

  logger.error("Unhandled error", { message: err.message, stack: err.stack });
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
  });
}

module.exports = errorHandler;
