/**
 * The three classes dispatch understands, and every spelling that reaches
 * them.
 *
 * One module because the two ends of the match read it: a booking names the
 * class it needs, a driver's vehicle is classified into one, and the offer
 * list is the comparison of the two. Written twice, the two copies stop
 * agreeing and the symptom is a driver who is offered nothing and cannot be
 * told why.
 *
 * The aliases are not politeness. `vehicles.vehicle_type` is free text a
 * console operator types — "SUV", "4-wheel", "6 wheeler" — and every row
 * that predates this file has no normalised class at all. An unrecognised
 * type is deliberately NOT guessed into motorcycle: a driver with no
 * classifiable vehicle receives no offers and is told so, which is a
 * fixable state, where a silently mis-classified one is a car booking sent
 * to a scooter.
 */

/** The wire values. Anything outside this list is not a class. */
const CLASSES = ["motorcycle", "car", "truck6"];

/** What a person is shown. 'truck6' is a wire value, not a sentence. */
const LABELS = {
  motorcycle: "motorcycle",
  car: "car",
  truck6: "6-wheeler",
};

const ALIASES = {
  motorcycle: ["motorcycle", "motorbike", "moto", "scooter", "2-wheel", "2w"],
  car: ["car", "sedan", "suv", "hatchback", "mpv", "van", "4-wheel", "4w"],
  truck6: ["truck6", "truck", "6-wheel", "6-wheeler", "6w"],
};

/** alias -> class, built once rather than scanned per request. */
const BY_ALIAS = new Map();
for (const [klass, spellings] of Object.entries(ALIASES)) {
  for (const spelling of spellings) BY_ALIAS.set(spelling, klass);
}

/**
 * One class from whatever was written, or null.
 *
 * Separators are settled first — "6 wheeler", "6_wheeler" and "6-wheeler"
 * are one word typed three ways — and a trailing plural is tried second, so
 * "4 wheels" lands on "4-wheel" without "4-wheels" needing its own entry.
 */
function normalise(value) {
  if (value === null || value === undefined) return null;
  const word = String(value).trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (!word) return null;
  return BY_ALIAS.get(word) || BY_ALIAS.get(word.replace(/s$/, "")) || null;
}

/**
 * The class of the vehicle row dispatch picked, or null for "unclassifiable".
 *
 * The stored column wins; the free-text type is the fallback for rows
 * written before there was a column, and for anything the console wrote
 * without one.
 */
function classOfVehicle(vehicle) {
  if (!vehicle) return null;
  return normalise(vehicle.vehicle_class) || normalise(vehicle.vehicle_type);
}

/** How a class is said out loud, e.g. in the refusal to accept a ride. */
function labelOf(klass) {
  return LABELS[klass] || String(klass);
}

module.exports = { CLASSES, normalise, classOfVehicle, labelOf };
