const { Router } = require('express');
const controller = require('./auth.controller');
const { validateBody } = require('../../middleware/validate');
const {
  loginLimiter,
  registerLimiter,
  forgotPasswordLimiter,
  googleLimiter,
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

module.exports = router;
