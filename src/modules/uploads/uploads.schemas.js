const { z } = require("zod");

const uploadIdParams = z.object({ uploadId: z.string().uuid() });

// Which slot the file is for. A driver's licence and their OR/CR are
// different documents an admin reviews separately.
const kindSchema = z.object({
  kind: z.enum(["license_photo", "or_cr_photo", "profile_photo"]),
});

// Admin listing filters. Both optional; absent means "no filter".
const listQuerySchema = z.object({
  role: z.enum(["rider", "driver"]).optional(),
  kind: z.enum(["license_photo", "or_cr_photo", "profile_photo"]).optional(),
});

module.exports = { uploadIdParams, kindSchema, listQuerySchema };
