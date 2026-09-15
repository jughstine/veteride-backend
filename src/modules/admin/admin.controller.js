const adminService = require("./admin.service");
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
};
