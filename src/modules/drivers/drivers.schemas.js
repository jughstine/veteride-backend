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

module.exports = { submitVerificationDocumentsSchema };
