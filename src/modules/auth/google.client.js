const { OAuth2Client } = require("google-auth-library");
const env = require("../../config/env");
const AppError = require("../../utils/AppError");

const client = new OAuth2Client(env.google.clientId);

async function verifyGoogleIdToken(idToken) {
  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken,
      audience: env.google.clientId,
    });
  } catch (err) {
    throw new AppError(
      401,
      "INVALID_GOOGLE_TOKEN",
      "Google token could not be verified",
    );
  }

  const payload = ticket.getPayload();

  if (!payload || !payload.email_verified) {
    throw new AppError(
      401,
      "GOOGLE_EMAIL_UNVERIFIED",
      "Google account email is not verified",
    );
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    fullName: payload.name || null,
  };
}

module.exports = { verifyGoogleIdToken };
