const { z } = require("zod");

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

// All fields are required together; partial verification submissions aren't accepted.
const submitVerificationDocumentsSchema = z.object({
  date_of_birth: isoDate,
  license_number: z.string().trim().min(1).max(50),
  license_photo_url: z.string().url(),
  license_expiry: isoDate,
  or_cr_photo_url: z.string().url(),
});

/**
 * The online switch has two positions, and a missing field is not a third
 * one: anything that is not an affirmative is "offline". `true` is accepted
 * in its three wire spellings because a toggle is posted by whatever client
 * is to hand — the app, a console, curl — and being read as offline for
 * having sent the string is a driver who believes they are working.
 */
const availabilitySchema = z.object({
  online: z
    .union([z.boolean(), z.literal("true"), z.literal("false"), z.literal(0), z.literal(1)])
    .optional(),
});

module.exports = { submitVerificationDocumentsSchema, availabilitySchema };
