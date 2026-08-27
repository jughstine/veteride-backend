const AppError = require("../utils/AppError");

/**
 * Validates req.body with Zod and replaces it with the parsed result.
 */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
        .join("; ");
      return next(new AppError(400, "VALIDATION_ERROR", detail));
    }
    req.body = result.data;
    next();
  };
}

/** Same idea as validateBody, but for req.params (e.g. numeric IDs in the URL). */
function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`)
        .join("; ");
      return next(new AppError(400, "VALIDATION_ERROR", detail));
    }
    req.params = result.data;
    next();
  };
}

/**
 * Query params are strings; use z.coerce for numeric/boolean fields.
 */
function validateQuery(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
        .join("; ");
      return next(new AppError(400, "VALIDATION_ERROR", detail));
    }
    req.query = result.data;
    next();
  };
}

module.exports = { validateBody, validateParams, validateQuery };
