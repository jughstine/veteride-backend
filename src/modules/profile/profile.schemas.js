const { z } = require("zod");

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const updateProfileSchema = z
  .object({
    full_name: z.string().trim().min(1).max(255).optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    date_of_birth: z.string().date().optional(), // "YYYY-MM-DD"
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

const updatePreferencesSchema = z
  .object({
    preferred_payment_method: z
      .enum(["cash", "gcash", "maya", "card"])
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

// password is optional at the schema layer -- authService decides at
// runtime whether it's actually required (Google-only accounts have none).
const deleteAccountSchema = z.object({
  password: z.string().min(1).optional(),
});

const createPlaceSchema = z.object({
  label: z.string().trim().min(1).max(100),
  address: z.string().trim().min(1).max(255),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const walletLedgerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
});

/**
 * A handset registering itself for push.
 *
 * `token` is the Firebase Installation ID in firebase_messaging 17, not the
 * old registration token. 255 because Google has never committed to a length
 * and has changed it before.
 *
 * THE ACCOUNT IS NOT IN HERE and must never be: it comes from the access
 * token. A token addressed to an account the caller names is a way to
 * receive somebody else's rides.
 */
const pushTokenSchema = z.object({
  token: z.string().trim().min(1).max(255),
  platform: z.enum(["android", "ios"]).default("android"),
});

module.exports = {
  idParamSchema,
  pushTokenSchema,
  updateProfileSchema,
  updatePreferencesSchema,
  deleteAccountSchema,
  createPlaceSchema,
  walletLedgerQuerySchema,
};
