const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/tokens');

/**
 * Not used by the /auth/* routes themselves (login/register issue tokens,
 * logout revokes via the refresh token in the body), but every OTHER
 * protected route in the app should sit behind this.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'MISSING_TOKEN', 'Authorization header must be a Bearer token'));
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    next(err); // translated to 401 INVALID_TOKEN by the central error handler
  }
}

/** Restricts a route to one or more roles, e.g. requireRole('admin'). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'You do not have access to this resource'));
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
