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
 *
 * The parsed result is written with defineProperty, not assignment. Express 5
 * made `req.query` a getter with no setter, so `req.query = parsed` fails
 * *silently* — no throw, no warning — and every handler downstream keeps
 * reading the raw strings it thought had been coerced. That is quiet in a
 * comparison ("14.6" - 0.09 is a number) and loud in an addition
 * ("14.6" + 0.09 is "14.60.09"), so a validated numeric query can produce a
 * WHERE clause that silently matches nothing.
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
    Object.defineProperty(req, "query", {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
}

module.exports = { validateBody, validateParams, validateQuery };
