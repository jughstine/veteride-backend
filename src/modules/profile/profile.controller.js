const profileService = require("./profile.service");
const asyncHandler = require("../../utils/asyncHandler");

const getMe = asyncHandler(async (req, res) => {
  const profile = await profileService.getMe(req.user.id);
  res.status(200).json(profile);
});

const updateMe = asyncHandler(async (req, res) => {
  const profile = await profileService.updateMe(req.user.id, req.body);
  res.status(200).json(profile);
});

const updatePreferences = asyncHandler(async (req, res) => {
  const profile = await profileService.updatePreferences(req.user.id, req.body);
  res.status(200).json(profile);
});

const deleteMe = asyncHandler(async (req, res) => {
  await profileService.deleteMe(req.user.id, { password: req.body.password });
  res.status(204).send();
});

const listPlaces = asyncHandler(async (req, res) => {
  const places = await profileService.listPlaces(req.user.id);
  res.status(200).json(places);
});

const createPlace = asyncHandler(async (req, res) => {
  const place = await profileService.createPlace(req.user.id, req.body);
  res.status(201).json(place);
});

const deletePlace = asyncHandler(async (req, res) => {
  await profileService.deletePlace(req.user.id, req.params.id);
  res.status(204).send();
});

const listPaymentMethods = asyncHandler(async (req, res) => {
  const methods = await profileService.listPaymentMethods(req.user.id);
  res.status(200).json(methods);
});

const deletePaymentMethod = asyncHandler(async (req, res) => {
  await profileService.deletePaymentMethod(req.user.id, req.params.id);
  res.status(204).send();
});

const getWallet = asyncHandler(async (req, res) => {
  const wallet = await profileService.getWallet(req.user.id);
  res.status(200).json(wallet);
});

// req.query is already validated and coerced (limit/cursor are numbers
// by this point) by the validateQuery(walletLedgerQuerySchema) middleware.
const getWalletLedger = asyncHandler(async (req, res) => {
  const { limit, cursor } = req.query;
  const result = await profileService.getWalletLedger(req.user.id, {
    limit,
    cursor,
  });
  res.status(200).json(result);
});

module.exports = {
  getMe,
  updateMe,
  updatePreferences,
  deleteMe,
  listPlaces,
  createPlace,
  deletePlace,
  listPaymentMethods,
  deletePaymentMethod,
  getWallet,
  getWalletLedger,
};
