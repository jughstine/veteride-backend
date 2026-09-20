const tripService = require("./trips.service");
const asyncHandler = require("../../utils/asyncHandler");

const book = asyncHandler(async (req, res) => {
  const trip = await tripService.book(req.user.id, {
    pickupAddress: req.body.pickup_address,
    pickupLat: req.body.pickup_lat,
    pickupLng: req.body.pickup_lng,
    dropoffAddress: req.body.dropoff_address,
    dropoffLat: req.body.dropoff_lat,
    dropoffLng: req.body.dropoff_lng,
    distanceKm: req.body.distance_km,
    estimatedMinutes: req.body.estimated_duration_min ?? req.body.estimated_minutes,
    estimatedFare: req.body.estimated_fare,
    vehicleClass: req.body.vehicle_class,
    service: req.body.service,
    paymentMethod: req.body.payment_method,
  });
  res.status(201).json({ trip });
});

// A 200 carrying {"trip": null} is the true answer "nothing is live" — not a
// 404, which the app would have to tell apart from a dead connection.
const current = asyncHandler(async (req, res) => {
  res.status(200).json({ trip: await tripService.current(req.user.id, req.user.role) });
});

const readOne = asyncHandler(async (req, res) => {
  res.status(200).json({ trip: await tripService.readOne(req.params.tripId, req.user.id, req.user.role) });
});

const openRequests = asyncHandler(async (req, res) => {
  // An empty list is an answer — "nobody is booking" — and the driver's
  // screen has to render it as one rather than as silence. `reason` is the
  // other kind of empty: this driver cannot be offered anything at all, and
  // needs to be told which of the two silences they are looking at.
  const { requests, reason } = await tripService.openRequests(req.user.id, {
    lat: req.query.lat,
    lng: req.query.lng,
  });
  res.status(200).json({ requests, reason });
});

const accept = asyncHandler(async (req, res) => {
  res.status(200).json({ trip: await tripService.accept(req.params.tripId, req.user.id) });
});

// The driver passes. 200 with the pass and how long it lasts — not 204,
// because the app shows the driver why the card will not come straight back
// and must not have to invent the number. Nothing about the ride changes:
// the booking stays open and every other driver in range still sees it.
const decline = asyncHandler(async (req, res) => {
  res.status(200).json(await tripService.decline(req.params.tripId, req.user.id));
});

const advance = asyncHandler(async (req, res) => {
  const trip = await tripService.advance(req.params.tripId, {
    accountId: req.user.id,
    role: req.user.role,
    to: req.body.to,
    pin: req.body.pin,
    reason: req.body.reason,
  });
  res.status(200).json({ trip });
});

// The whole trip comes back, not just the rating: the driver's new average
// is on it, and the app's rating screen is the last thing the passenger
// sees of this ride.
const rate = asyncHandler(async (req, res) => {
  const trip = await tripService.rate(req.params.tripId, req.user.id, {
    rating: req.body.rating,
    // The app's own field is `tip`; `tip_amount` is the column's name and
    // an easy thing for a client to send instead.
    tip: req.body.tip ?? req.body.tip_amount,
    comment: req.body.comment,
  });
  res.status(201).json({ trip });
});

const postPosition = asyncHandler(async (req, res) => {
  await tripService.postPosition(req.user.id, {
    lat: req.body.lat,
    lng: req.body.lng,
    heading: req.body.heading,
    accuracyM: req.body.accuracy_m,
  });
  res.status(204).end();
});

const readMessages = asyncHandler(async (req, res) => {
  const messages = await tripService.readMessages(req.params.tripId, req.user.id, req.user.role);
  res.status(200).json({ messages });
});

const postMessage = asyncHandler(async (req, res) => {
  const message = await tripService.postMessage(req.params.tripId, {
    accountId: req.user.id,
    role: req.user.role,
    body: req.body.body,
  });
  res.status(201).json({ message });
});

module.exports = {
  book,
  current,
  readOne,
  openRequests,
  accept,
  decline,
  advance,
  rate,
  postPosition,
  readMessages,
  postMessage,
};
