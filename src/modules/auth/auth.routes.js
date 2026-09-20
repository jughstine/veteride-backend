const { Router } = require('express');
const controller = require('./auth.controller');
const { validateBody } = require('../../middleware/validate');
const {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  googleLimiter,
  emailCodeRequestLimiter,
  emailCodeRequestIpLimiter,
  emailCodeVerifyLimiter,
  emailCodeVerifyIpLimiter,
} = require('../../middleware/rateLimiters');
const schemas = require('./auth.schemas');

const router = Router();

router.post(
  '/register',
  registerLimiter,
  validateBody(schemas.registerSchema),
  controller.register
);

router.post(
  '/login',
  loginLimiter,
  validateBody(schemas.loginSchema),
  controller.login
);

router.post(
  '/google',
  googleLimiter,
  validateBody(schemas.googleSchema),
  controller.google
);

router.post(
  '/google/complete',
  googleLimiter,
  validateBody(schemas.googleCompleteSchema),
  controller.googleComplete
);

router.post(
  '/refresh',
  validateBody(schemas.refreshSchema),
  controller.refresh
);

router.post(
  '/logout',
  validateBody(schemas.logoutSchema),
  controller.logout
);

router.post(
  '/password/forgot',
  forgotPasswordLimiter,
  validateBody(schemas.forgotPasswordSchema),
  controller.forgotPassword
);

router.post(
  '/password/reset',
  validateBody(schemas.resetPasswordSchema),
  controller.resetPassword
);

// Emailed sign-in codes.
//
// Two limiters on each route and validateBody BETWEEN them, which is the one
// place this file departs from the limiter-first order used above. The
// per-caller limiter needs only req.ip and so runs first, as everywhere
// else; the per-identifier limiter keys on the BODY, and keying on an
// unvalidated body means keying on whatever a caller sent -- an object, an
// array, a 4 KB string -- one bucket each, which is a limiter that limits
// nothing. So the schema runs first and the identifier limiter keys on the
// trimmed, typed value the service will look up.
router.post(
  '/email-code',
  emailCodeRequestIpLimiter,
  validateBody(schemas.emailCodeRequestSchema),
  emailCodeRequestLimiter,
  controller.requestEmailCode
);

router.post(
  '/email-code/verify',
  emailCodeVerifyIpLimiter,
  validateBody(schemas.emailCodeVerifySchema),
  emailCodeVerifyLimiter,
  controller.verifyEmailCode
);

module.exports = router;
