const { z } = require("zod");

// A coordinate, not a number that happens to parse. `Number(null)` and
// `Number('')` are both 0, which is a real place in the Gulf of Guinea — so
// the absent cases are rejected by the type, never coerced.
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);

const address = z.string().trim().min(1).max(255);
const tripId = z.string().uuid();

const bookSchema = z.object({
  pickup_address: address,
  pickup_lat: lat,
  pickup_lng: lng,
  dropoff_address: address,
  dropoff_lat: lat,
  dropoff_lng: lng,

  // The quoted figures, so the row records what the passenger agreed to.
  // The column widths are part of the validation: distance_km is
  // DECIMAL(6,2) and estimated_fare DECIMAL(10,2), and a number past either
  // arrives as a numeric overflow rather than a readable 400.
  distance_km: z.number().min(0).max(9999.99).optional(),
  estimated_minutes: z.number().int().min(0).max(100000).optional(),
  // The app's spelling of the same figure. Both are accepted because zod
  // STRIPS what it does not declare and validate.js then replaces the body
  // with the parsed result — so the estimate the passenger was shown was
  // arriving here and being silently dropped on the way to the column,
  // leaving every row with a NULL duration and every driver's card with no
  // ETA on it.
  estimated_duration_min: z.number().int().min(0).max(100000).optional(),
  estimated_fare: z.number().min(0).max(99999999.99).optional(),

  // What the booking needs, and what the job is. Free text here and
  // normalised in the service: the console types "SUV" and older builds of
  // the app send their own service words, and one spelling table for all of
  // them lives in modules/drivers/vehicle-class.js. An unrecognised class
  // is refused there rather than defaulted, because a booking quietly
  // turned into a motorcycle is a car the passenger will wait for for ever.
  vehicle_class: z.string().trim().min(1).max(40).optional(),
  service: z.string().trim().min(1).max(40).optional(),
});

const tripIdParams = z.object({ tripId });

// Query params arrive as strings; coerce, then validate as coordinates.
const openQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

const statusSchema = z.object({
  to: z.enum(["en_route_pickup", "in_progress", "completed", "cancelled"]),
  pin: z.string().trim().regex(/^[0-9]{4}$/).optional(),
  reason: z.string().trim().max(255).optional(),
});

const positionSchema = z.object({
  lat,
  lng,
  heading: z.number().min(0).max(360).optional(),
  accuracy_m: z.number().min(0).max(100000).optional(),
});

const messageSchema = z.object({
  body: z.string().trim().min(1).max(2000),
});

module.exports = {
  bookSchema,
  tripIdParams,
  openQuerySchema,
  statusSchema,
  positionSchema,
  messageSchema,
};
