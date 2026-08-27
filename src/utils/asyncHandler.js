// Express 5 already forwards rejected async handlers to next() automatically,
// but wrapping explicitly keeps this codebase correct even if it's ever
// downgraded to Express 4, and makes the intent obvious at each route.
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
