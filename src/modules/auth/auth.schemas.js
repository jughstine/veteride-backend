const { z } = require("zod");

// Allows country-specific formats; stricter validation can be added later.
const phone = z.string().trim().min(7).max(20);
const password = z.string().min(8).max(128);

// Fields common to both roles at signup time.
const baseRegisterFields = {
  full_name: z.string().trim().min(1).max(255),
  email: z.string().trim().email(),
  phone,
  password,
};

// Driver accounts are created immediately; verification is completed post-login
// via /drivers/me/verification-documents and only gates driver operations.
const driverRegisterSchema = z.object({
  role: z.literal("driver"),
  ...baseRegisterFields,
});

const riderRegisterSchema = z.object({
  role: z.literal("rider"),
  ...baseRegisterFields,
});

// Role is required to match loginSchema; clients must send role explicitly.
const registerSchema = z.discriminatedUnion("role", [
  riderRegisterSchema,
  driverRegisterSchema,
]);

const loginSchema = z.object({
  role: z.enum(["rider", "driver", "admin"]),
  identifier: z.string().trim().min(1), // email or phone
  password: z.string().min(1),
});

const googleSchema = z.object({
  id_token: z.string().min(1),
});

const googleCompleteSchema = z.object({
  id_token: z.string().min(1),
  phone,
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

const logoutSchema = z.object({
  refresh_token: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  role: z.enum(["rider", "driver", "admin"]),
  identifier: z.string().trim().min(1),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  new_password: password,
});

module.exports = {
  registerSchema,
  loginSchema,
  googleSchema,
  googleCompleteSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
};
