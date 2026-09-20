const authService = require("./auth.service");
const asyncHandler = require("../../utils/asyncHandler");
const env = require("../../config/env");

function sessionResponse(res, statusCode, result) {
  const { accessToken, refreshToken, ...rest } = result;
  return res.status(statusCode).json({
    ...rest,
    access_token: accessToken,
    refresh_token: refreshToken,
  });
}

const register = asyncHandler(async (req, res) => {
  const { role, full_name, email, phone, password } = req.body;
  const result = await authService.register(
    { role, fullName: full_name, email, phone, password },
    req.ip,
  );
  sessionResponse(res, 201, result);
});

const login = asyncHandler(async (req, res) => {
  const { role, identifier, password } = req.body;
  const result = await authService.login(
    { role, identifier, password },
    req.ip,
  );
  sessionResponse(res, 200, result);
});

const google = asyncHandler(async (req, res) => {
  const result = await authService.googleSignIn(
    { idToken: req.body.id_token },
    req.ip,
  );

  if (result.status === "needs_phone") {
    return res.status(200).json({ status: "needs_phone", email: result.email });
  }
  sessionResponse(res, 200, result);
});

const googleComplete = asyncHandler(async (req, res) => {
  const result = await authService.googleComplete(
    { idToken: req.body.id_token, phone: req.body.phone },
    req.ip,
  );
  sessionResponse(res, 201, result);
});

const refresh = asyncHandler(async (req, res) => {
  const result = await authService.refresh(
    { refreshToken: req.body.refresh_token },
    req.ip,
  );
  sessionResponse(res, 200, result);
});

const logout = asyncHandler(async (req, res) => {
  await authService.logout({ refreshToken: req.body.refresh_token });
  res.status(204).send();
});

// Always return 202 to avoid revealing whether the account exists.
const forgotPassword = asyncHandler(async (req, res) => {
  const { role, identifier } = req.body;
  await authService.forgotPassword({ role, identifier });
  res
    .status(202)
    .json({ message: "If an account exists, a reset link has been sent." });
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, new_password } = req.body;
  await authService.resetPassword({ token, newPassword: new_password });
  res.status(200).json({ message: "Password has been reset." });
});

// One 202 and one sentence, whatever happened behind it. Same discipline as
// forgotPassword above: an account that exists and one that does not must
// produce byte-identical replies, so nothing account-shaped goes in the
// body. `expires_in_minutes` is a server setting, the same number for
// everybody, and the app needs it to run the countdown on the code screen.
const requestEmailCode = asyncHandler(async (req, res) => {
  const { role, identifier } = req.body;
  await authService.requestEmailCode({ role, identifier }, req.ip);
  res.status(202).json({
    status: "email_code_sent",
    message: "If an account exists, a sign-in code has been sent to its e-mail.",
    expires_in_minutes: env.emailCode.ttlMinutes,
  });
});

// 200 and the LOGIN BODY, exactly: {status, user, role, access_token,
// refresh_token} through the same sessionResponse every other session flow
// in this file goes through. The app has one function that adopts a
// session; this must not give it a second shape to learn.
const verifyEmailCode = asyncHandler(async (req, res) => {
  const { role, identifier, code } = req.body;
  const result = await authService.verifyEmailCode(
    { role, identifier, code },
    req.ip,
  );
  sessionResponse(res, 200, result);
});

module.exports = {
  register,
  login,
  google,
  googleComplete,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  requestEmailCode,
  verifyEmailCode,
};
