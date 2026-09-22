const { z } = require("zod");

const uploadIdParams = z.object({ uploadId: z.string().uuid() });

// Which slot the file is for. A driver's licence and their OR/CR are
// different documents an admin reviews separately.
/**
 * What a driver has to file before they can carry anybody, and the only
 * names an upload may claim.
 *
 * `license_photo` is the FRONT of the licence and keeps its old name: rows
 * already exist under it, and renaming a kind would orphan every document
 * uploaded before today.
 *
 * The vehicle is three separate kinds rather than one, because a reviewer
 * comparing the plate against the OR/CR needs the plate on its own and not
 * as whichever of three photos happened to be uploaded last.
 *
 * `profile_photo` is the face shown to passengers, not a document; it is in
 * the same list because it goes through the same route.
 */
const DOCUMENT_KINDS = [
  "license_photo",
  "license_back",
  "or_cr_photo",
  "nbi_clearance",
  "vehicle_front",
  "vehicle_side",
  "vehicle_plate",
  "profile_photo",
];

const kindSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS),
});

// Admin listing filters. Both optional; absent means "no filter".
const listQuerySchema = z.object({
  role: z.enum(["rider", "driver"]).optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
});

module.exports = {
  uploadIdParams,
  kindSchema,
  listQuerySchema,
  DOCUMENT_KINDS,
};
