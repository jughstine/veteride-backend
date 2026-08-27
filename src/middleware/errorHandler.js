const AppError = require("../utils/AppError");
const logger = require("../utils/logger");

function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
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
