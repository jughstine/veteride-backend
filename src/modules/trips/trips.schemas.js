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

  // The route the passenger's screen measured, and the fare it quoted
  // them. Accepted, bounded, and then answered: the service prices the
  // ride itself from the tariff and these coordinates
  // (modules/trips/fares.js), clamps this distance between the straight
  // line and a ceiling no real route reaches, and stores its own figures.
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

  // How the passenger means to settle it. Free text here and normalised in
  // modules/trips/payment-methods.js for the same reason the class is: the
  // app spells its six methods one way, this API's own preferences column
  // spells two of them another, and an unknown spelling is refused rather
  // than quietly recorded as cash. Absent means "whatever they usually
  // choose", which the service reads off their profile.
  payment_method: z.string().trim().min(1).max(40).optional(),
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

/**
 * The passenger's verdict on a finished ride.
 *
 * Whole stars, because that is what the screen collects and a 4.5 is a
 * number nobody chose. The tip arrives under either name: the app's own
 * field is `tip` and the column it lands in is `tip_amount`, and this
 * schema strips what it does not declare — which is exactly how
 * `estimated_duration_min` and `service` were being dropped on the way to
 * the database before anyone noticed.
 *
 * The tip is capped at a flat ₱100, the owner's rule (15 Sep 2026): a tip
 * over that is refused here as a 400 rather than quietly trimmed, so a
 * passenger who fat-fingered an extra zero is told, not charged the ceiling
 * they never meant. The service enforces the same limit again.
 */
const ratingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  tip: z.number().min(0).max(100).optional(),
  tip_amount: z.number().min(0).max(100).optional(),
  comment: z.string().trim().max(500).optional(),
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
  ratingSchema,
  positionSchema,
  messageSchema,
};
