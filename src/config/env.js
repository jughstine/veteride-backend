require("dotenv").config({ quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requiredList(name) {
  const raw = required(name);
  const values = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`Env var ${name} must contain at least one value`);
  }
  return values;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT || "3000", 10),

  db: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306", 10),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: required("DB_NAME"),
  },

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET"),
    accessTtl: process.env.JWT_ACCESS_TTL || "15m",
  },

  refreshToken: {
    ttlDays: parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || "30", 10),
  },

  passwordReset: {
    ttlMinutes: parseInt(process.env.RESET_TOKEN_TTL_MIN || "30", 10),
  },

  google: {
    clientIds: requiredList("GOOGLE_CLIENT_IDS"),
  },

  bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || "12", 10),
};
