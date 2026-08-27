const authService = require("./auth.service");
const asyncHandler = require("../../utils/asyncHandler");

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

module.exports = {
  register,
  login,
  google,
  googleComplete,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
};
