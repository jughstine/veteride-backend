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
    estimatedMinutes: req.body.estimated_minutes,
    estimatedFare: req.body.estimated_fare,
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
  const requests = await tripService.openRequests(req.user.id, {
    lat: req.query.lat,
    lng: req.query.lng,
  });
  // An empty list is an answer — "nobody is booking" — and the driver's
  // screen has to render it as one rather than as silence.
  res.status(200).json({ requests });
});

const accept = asyncHandler(async (req, res) => {
  res.status(200).json({ trip: await tripService.accept(req.params.tripId, req.user.id) });
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
  advance,
  postPosition,
  readMessages,
  postMessage,
};
