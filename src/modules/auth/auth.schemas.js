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

// Same {role, identifier} pair loginSchema and forgotPasswordSchema take, so
// the app sends the account it is already holding without reshaping it.
const emailCodeRequestSchema = z.object({
  role: z.enum(["rider", "driver", "admin"]),
  identifier: z.string().trim().min(1), // email or phone
});

// Exactly six digits, as a string: "004321" is a real code and Number()
// would turn it into 4321. The regex also keeps a malformed guess from ever
// reaching the hash comparison.
const emailCodeVerifySchema = z.object({
  role: z.enum(["rider", "driver", "admin"]),
  identifier: z.string().trim().min(1),
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, "must be six digits"),
});

// Six digits, as a string. "004321" is a real code and Number() would make
// it 4321; the regex also keeps a malformed guess away from the comparison.
const authenticatorCode = z
  .string()
  .trim()
  .regex(/^[0-9]{6}$/, "must be six digits");

const authenticatorConfirmSchema = z.object({ code: authenticatorCode });

const authenticatorVerifySchema = z.object({
  challenge_token: z.string().min(1),
  code: authenticatorCode,
});

const authenticatorDisableSchema = z.object({ code: authenticatorCode });

module.exports = {
  authenticatorConfirmSchema,
  authenticatorVerifySchema,
  authenticatorDisableSchema,
  registerSchema,
  loginSchema,
  googleSchema,
  googleCompleteSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  emailCodeRequestSchema,
  emailCodeVerifySchema,
};
