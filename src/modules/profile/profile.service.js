const AppError = require("../../utils/AppError");
const { comparePassword } = require("../../utils/password");
const profileRepo = require("./repositories/profile.repository");
const paymentMethodRepo = require("./repositories/payment-method.repository");
const savedPlaceRepo = require("./repositories/saved-place.repository");
const walletRepo = require("./repositories/wallet.repository");

// Reused from auth to avoid duplication; promote to a shared domain module if it grows.
const userRepo = require("../auth/repositories/user.repository");
const tokenRepo = require("../auth/repositories/token.repository");

function stripSensitive(profileRow) {
  const { password_hash, ...safe } = profileRow;
  return safe;
}

async function getRequiredProfile(userId) {
  const profile = await profileRepo.getProfileById(userId);
  if (!profile) {
    // Guards against deleted or edge-case accounts with a valid token.
    throw new AppError(404, "PROFILE_NOT_FOUND", "Profile not found");
  }
  return profile;
}

// ---------------------------------------------------------------------
// GET /me
// ---------------------------------------------------------------------
async function getMe(userId) {
  const profile = await getRequiredProfile(userId);
  const paymentMethods = await paymentMethodRepo.listByCustomer(userId);

  return {
    ...stripSensitive(profile),
    linked_payment_methods: paymentMethods,
  };
}

// ---------------------------------------------------------------------
// PATCH /me
// ---------------------------------------------------------------------
async function updateMe(userId, { full_name, phone, date_of_birth }) {
  if (phone !== undefined) {
    const taken = await userRepo.isPhoneTakenByOtherRider(phone, userId);
    if (taken) {
      throw new AppError(
        409,
        "PHONE_TAKEN",
        "This phone number is already registered",
      );
    }
  }

  const fields = {};
  if (full_name !== undefined) fields.full_name = full_name;
  if (phone !== undefined) fields.phone_number = phone;
  if (date_of_birth !== undefined) fields.date_of_birth = date_of_birth;

  await profileRepo.updateProfileFields(userId, fields);
  return getMe(userId);
}

// ---------------------------------------------------------------------
// PATCH /me/preferences
// ---------------------------------------------------------------------
async function updatePreferences(userId, body) {
  await profileRepo.updatePreferences(userId, {
    preferredPaymentMethod: body.preferred_payment_method,
  });
  return getMe(userId);
}

// ---------------------------------------------------------------------
// DEL /me
// ---------------------------------------------------------------------

/**
 * TODO: wire this up once the trips/payments modules exist. Should check
 * for any trip in a non-terminal status (requested/matching/matched/
 * en_route_pickup/in_progress) or any payment with status 'pending' for
 * this rider. Deliberately fails closed (blocks deletion) is the wrong
 * default for a stub -- fails OPEN (allows deletion) so local dev/testing
 * isn't blocked, but this MUST be implemented for real before shipping
 * account deletion to production.
 */
async function hasActiveTripOrUnpaidFare(userId) {
  return false;
}

async function deleteMe(userId, { password }) {
  const account = await userRepo.findByIdForRole("rider", userId);
  if (!account) {
    throw new AppError(404, "PROFILE_NOT_FOUND", "Profile not found");
  }

  if (await hasActiveTripOrUnpaidFare(userId)) {
    throw new AppError(
      409,
      "ACTIVE_TRIP_OR_UNPAID_FARE",
      "Cannot delete account while a trip is active or a fare is unpaid",
    );
  }

  // Google-only accounts never set a password -- nothing to confirm against.
  if (account.password_hash) {
    if (!password) {
      throw new AppError(
        400,
        "PASSWORD_REQUIRED",
        "Password is required to delete this account",
      );
    }
    const matches = await comparePassword(password, account.password_hash);
    if (!matches) {
      throw new AppError(401, "INVALID_CREDENTIALS", "Incorrect password");
    }
  }

  await profileRepo.softDeleteById(userId);
  await tokenRepo.revokeAllRefreshTokensForUser("rider", userId);
}

// ---------------------------------------------------------------------
// GET /me/places
// ---------------------------------------------------------------------
async function listPlaces(userId) {
  return savedPlaceRepo.listByCustomer(userId);
}

// ---------------------------------------------------------------------
// POST /me/places
// ---------------------------------------------------------------------
async function createPlace(userId, { label, address, lat, lng }) {
  return savedPlaceRepo.create(userId, { label, address, lat, lng });
}

// ---------------------------------------------------------------------
// DEL /me/places/{id}
// ---------------------------------------------------------------------
async function deletePlace(userId, placeId) {
  const existing = await savedPlaceRepo.findByIdForCustomer(placeId, userId);
  if (!existing) {
    // Same response whether the place doesn't exist or belongs to someone
    // else -- don't reveal which, that would leak other users' IDs.
    throw new AppError(404, "PLACE_NOT_FOUND", "Saved place not found");
  }
  await savedPlaceRepo.deleteByIdForCustomer(placeId, userId);
}

// ---------------------------------------------------------------------
// GET /me/payment-methods
// ---------------------------------------------------------------------
async function listPaymentMethods(userId) {
  return paymentMethodRepo.listByCustomer(userId);
}

// ---------------------------------------------------------------------
// DEL /me/payment-methods/{id}
// ---------------------------------------------------------------------
async function deletePaymentMethod(userId, paymentMethodId) {
  const existing = await paymentMethodRepo.findByIdForCustomer(
    paymentMethodId,
    userId,
  );
  if (!existing) {
    // Same non-disclosure pattern as deletePlace above.
    throw new AppError(
      404,
      "PAYMENT_METHOD_NOT_FOUND",
      "Payment method not found",
    );
  }
  await paymentMethodRepo.softDeleteById(paymentMethodId, userId);
}

// Converts the DB decimal wallet balance to integer centavos at the API boundary.
function toMinorUnits(decimalString) {
  return Math.round(Number(decimalString) * 100);
}

// ---------------------------------------------------------------------
// GET /me/wallet
// ---------------------------------------------------------------------
async function getWallet(userId) {
  const profile = await getRequiredProfile(userId);
  return { balance_minor: toMinorUnits(profile.wallet_balance) };
}

// ---------------------------------------------------------------------
// GET /me/wallet/ledger
// ---------------------------------------------------------------------
async function getWalletLedger(userId, { limit, cursor }) {
  const rows = await walletRepo.listLedger(userId, { limit, cursor });

  const items = rows.map((row) => ({
    id: row.id,
    amount_minor: Number(row.amount_minor),
    type: row.type,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    balance_after_minor: Number(row.balance_after_minor),
    created_at: row.created_at,
  }));

  // Short pages mark the end; full pages may trigger one extra fetch instead of a COUNT.
  const next_cursor = rows.length === limit ? rows[rows.length - 1].id : null;

  return { items, next_cursor };
}

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
