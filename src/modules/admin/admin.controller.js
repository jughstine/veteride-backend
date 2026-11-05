const adminService = require("./admin.service");
const walletService = require("../wallet/wallet.service");
const asyncHandler = require("../../utils/asyncHandler");

// --- Reads ---

const overview = asyncHandler(async (req, res) => {
  res.status(200).json(await adminService.overview());
});

const listRiders = asyncHandler(async (req, res) => {
  res.status(200).json(await adminService.listRiders(req.query));
});

const listDrivers = asyncHandler(async (req, res) => {
  res.status(200).json(await adminService.listDrivers(req.query));
});

const listTrips = asyncHandler(async (req, res) => {
  res.status(200).json(await adminService.listTrips(req.query));
});

const getTrip = asyncHandler(async (req, res) => {
  res.status(200).json(await adminService.getTrip(req.params.tripId));
});

const listPayments = asyncHandler(async (req, res) => {
  res.status(200).json(await adminService.listPayments(req.query));
});

const listDocuments = asyncHandler(async (req, res) => {
  res.status(200).json(await adminService.listDocuments(req.query));
});

// --- Writes ---

const setDriverVerification = asyncHandler(async (req, res) => {
  const result = await adminService.setDriverVerification(
    req.params.driverId,
    { decision: req.body.decision, note: req.body.note },
    req.user.id,
  );
  res.status(200).json(result);
});

const reviewDocument = asyncHandler(async (req, res) => {
  const result = await adminService.reviewDocument(
    req.params.uploadId,
    { status: req.body.status, notes: req.body.notes },
    req.user.id,
  );
  res.status(200).json(result);
});

const setAccountStatus = asyncHandler(async (req, res) => {
  const result = await adminService.setAccountStatus(
    req.params.role,
    req.params.accountId,
    req.body.status,
  );
  res.status(200).json(result);
});

const createVehicle = asyncHandler(async (req, res) => {
  const result = await adminService.createVehicle(req.params.driverId, req.body);
  res.status(201).json(result);
});

const updateVehicle = asyncHandler(async (req, res) => {
  const result = await adminService.updateVehicle(req.params.vehicleId, req.body);
  res.status(200).json(result);
});

const cancelTrip = asyncHandler(async (req, res) => {
  const result = await adminService.cancelTrip(req.params.tripId, req.body.reason);
  res.status(200).json(result);
});

// --- Cash-out queue ---
//
// Phase 1 is settled by hand: the driver asks, the wallet is debited there
// and then, the request appears here, somebody sends the money and marks it
// sent. Phase 2 replaces that middle step with PayMongo and changes neither
// these routes nor the app.

const listPayouts = asyncHandler(async (req, res) => {
  res.status(200).json(await walletService.adminListPayouts(req.query));
});

const settlePayout = asyncHandler(async (req, res) => {
  res.status(200).json(
    await walletService.settlePayout(req.params.payoutId, req.body.provider_ref),
  );
});

// Credits the wallet back, in the same transaction as the status change.
const failPayout = asyncHandler(async (req, res) => {
  res.status(200).json(
    await walletService.failPayout(req.params.payoutId, req.body.reason),
  );
});

module.exports = {
  overview,
  listRiders,
  listDrivers,
  listTrips,
  getTrip,
  listPayments,
  listDocuments,
  setDriverVerification,
  reviewDocument,
  setAccountStatus,
  createVehicle,
  updateVehicle,
  cancelTrip,
  listPayouts,
  settlePayout,
  failPayout,
};
