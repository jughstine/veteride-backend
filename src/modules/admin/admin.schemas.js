const { z } = require("zod");

// A per-role account id. BIGINT UNSIGNED in the database, so it is validated
// as a string of digits and passed on as one: parsing it to a JS number
// would quietly lose precision past 2^53, and nothing here does arithmetic
// on it. customers.user_id and drivers.driver_id are separate sequences, so
// the id alone never identifies a person — the route also carries the role.
const accountId = z.string().trim().regex(/^\d+$/, "Expected a numeric id");
const uuid = z.string().uuid();

// The four review states, shared by driver verification, one document, and a
// vehicle. Spelled identically to the ENUMs the migrations define.
const REVIEW_STATES = ["pending", "approved", "rejected", "resubmission_required"];

// The states auth reads on an account. 'active' restores; the other two
// suspend — a login is refused for anything that is not 'active'.
const ACCOUNT_STATES = ["active", "suspended", "banned"];

const TRIP_STATES = [
  "requested",
  "matched",
  "en_route_pickup",
  "in_progress",
  "completed",
  "cancelled",
];

const PAYMENT_STATES = ["pending", "completed", "failed", "refunded"];

// Query strings arrive as strings; coerce the numbers, then bound them. The
// limit is clamped so one request cannot ask for an unbounded table, which
// is the whole reason every list here is paged.
const pagination = {
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).max(120).optional(),
};

const ridersQuery = z.object({ ...pagination });

const driversQuery = z.object({
  ...pagination,
  verification: z.enum(REVIEW_STATES).optional(),
  availability: z.enum(["offline", "online", "on_trip"]).optional(),
});

const tripsQuery = z.object({
  ...pagination,
  status: z.enum(TRIP_STATES).optional(),
});

const paymentsQuery = z.object({
  ...pagination,
  status: z.enum(PAYMENT_STATES).optional(),
});

const documentsQuery = z.object({
  ...pagination,
  driverId: accountId.optional(),
  status: z.enum(REVIEW_STATES).optional(),
});

// --- Params ---
const driverIdParams = z.object({ driverId: accountId });
const uploadIdParams = z.object({ uploadId: uuid });
const vehicleIdParams = z.object({ vehicleId: uuid });
const tripIdParams = z.object({ tripId: uuid });
const accountParams = z.object({ role: z.enum(["rider", "driver"]), accountId });

// --- Bodies ---
const verificationBody = z.object({
  decision: z.enum(REVIEW_STATES),
  note: z.string().trim().max(500).optional(),
});

const documentReviewBody = z.object({
  status: z.enum(REVIEW_STATES),
  notes: z.string().trim().max(500).optional(),
});

const accountStatusBody = z.object({
  status: z.enum(ACCOUNT_STATES),
});

// A plate is one vehicle; it is trimmed and upper-cased so "ncr 1234" and
// "NCR 1234" cannot both be registered as different plates.
const plate = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .transform((v) => v.toUpperCase());

const vehicleCreateBody = z.object({
  plate_number: plate,
  vehicle_model: z.string().trim().min(1).max(100).optional(),
  // Free text — the class is normalised from it in the service.
  vehicle_type: z.string().trim().min(1).max(40).optional(),
  // An explicit class, also normalised; wins over the type when both are sent.
  vehicle_class: z.string().trim().min(1).max(40).optional(),
  vehicle_color: z.string().trim().min(1).max(40).optional(),
  verification_status: z.enum(REVIEW_STATES).optional(),
});

// Every field optional; the service refuses a body with nothing in it.
const vehicleUpdateBody = z.object({
  plate_number: plate.optional(),
  vehicle_model: z.string().trim().min(1).max(100).optional(),
  vehicle_type: z.string().trim().min(1).max(40).optional(),
  vehicle_class: z.string().trim().min(1).max(40).optional(),
  vehicle_color: z.string().trim().min(1).max(40).optional(),
  verification_status: z.enum(REVIEW_STATES).optional(),
});

const cancelTripBody = z.object({
  reason: z.string().trim().min(1).max(255),
});

module.exports = {
  ridersQuery,
  driversQuery,
  tripsQuery,
  paymentsQuery,
  documentsQuery,
  driverIdParams,
  uploadIdParams,
  vehicleIdParams,
  tripIdParams,
  accountParams,
  verificationBody,
  documentReviewBody,
  accountStatusBody,
  vehicleCreateBody,
  vehicleUpdateBody,
  cancelTripBody,
};
