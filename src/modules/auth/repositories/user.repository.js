const pool = require("../../../config/db");
const AppError = require("../../../utils/AppError");
const { getRoleConfig } = require("./role-tables");

/**
 * Looks up an account within a single role's table only
 */
async function findByIdentifierForRole(role, identifier) {
  const cfg = getRoleConfig(role);
  if (!cfg) return null;

  const whereParts = ["email = :identifier"];
  if (cfg.hasPhoneLogin) whereParts.push("phone_number = :identifier");

  const [rows] = await pool.query(
    `SELECT * FROM ${cfg.table} WHERE (${whereParts.join(" OR ")}) AND deleted_at IS NULL LIMIT 1`,
    { identifier },
  );
  return rows[0] || null;
}

async function findByIdForRole(role, id) {
  const cfg = getRoleConfig(role);
  if (!cfg) return null;

  const [rows] = await pool.query(
    `SELECT * FROM ${cfg.table} WHERE ${cfg.idColumn} = :id AND deleted_at IS NULL LIMIT 1`,
    { id },
  );
  return rows[0] || null;
}

/**
 * Used for the duplicate-email check at signup, where matching on phone too would be the wrong check.
 */
async function findByEmailForRole(role, email) {
  const cfg = getRoleConfig(role);
  if (!cfg) return null;

  const [rows] = await pool.query(
    `SELECT * FROM ${cfg.table} WHERE email = :email AND deleted_at IS NULL LIMIT 1`,
    { email },
  );
  return rows[0] || null;
}

async function findRiderByEmail(email) {
  const [rows] = await pool.query(
    "SELECT * FROM customers WHERE email = :email AND deleted_at IS NULL LIMIT 1",
    { email },
  );
  return rows[0] || null;
}

async function findRiderByGoogleId(googleId) {
  const [rows] = await pool.query(
    "SELECT * FROM customers WHERE google_id = :googleId AND deleted_at IS NULL LIMIT 1",
    { googleId },
  );
  return rows[0] || null;
}

/**
 * Ensures the phone number isn't already claimed by any account.
 */
async function isPhoneTaken(phone) {
  const [riderRows] = await pool.query(
    "SELECT user_id FROM customers WHERE phone_number = :phone AND deleted_at IS NULL LIMIT 1",
    { phone },
  );
  if (riderRows.length > 0) return true;

  const [driverRows] = await pool.query(
    "SELECT driver_id FROM drivers WHERE phone_number = :phone AND deleted_at IS NULL LIMIT 1",
    { phone },
  );
  return driverRows.length > 0;
}

/**
 * Checks if a phone is taken by another account, excluding the current rider.
 */
async function isPhoneTakenByOtherRider(phone, excludingUserId) {
  const [riderRows] = await pool.query(
    "SELECT user_id FROM customers WHERE phone_number = :phone AND user_id != :excludingUserId AND deleted_at IS NULL LIMIT 1",
    { phone, excludingUserId },
  );
  if (riderRows.length > 0) return true;

  const [driverRows] = await pool.query(
    "SELECT driver_id FROM drivers WHERE phone_number = :phone AND deleted_at IS NULL LIMIT 1",
    { phone },
  );
  return driverRows.length > 0;
}

async function createRider({
  fullName,
  email,
  phone,
  passwordHash,
  googleId = null,
  emailVerified = false,
}) {
  const [result] = await pool.query(
    `INSERT INTO customers (full_name, email, phone_number, password_hash, google_id, email_verified, status, is_verified)
     VALUES (:fullName, :email, :phone, :passwordHash, :googleId, :emailVerified, 'active', FALSE)`,
    { fullName, email, phone, passwordHash, googleId, emailVerified },
  );
  return findByIdForRole("rider", result.insertId);
}

async function isLicenseNumberTaken(licenseNumber) {
  const [rows] = await pool.query(
    "SELECT driver_id FROM drivers WHERE license_number = :licenseNumber AND deleted_at IS NULL LIMIT 1",
    { licenseNumber },
  );
  return rows.length > 0;
}

/**
 * Checks if a license number is taken by another driver, excluding the current one.
 */
async function isLicenseNumberTakenByOtherDriver(
  licenseNumber,
  excludingDriverId,
) {
  const [rows] = await pool.query(
    `SELECT driver_id FROM drivers
     WHERE license_number = :licenseNumber AND driver_id != :excludingDriverId
       AND deleted_at IS NULL LIMIT 1`,
    { licenseNumber, excludingDriverId },
  );
  return rows.length > 0;
}

/**
 * Creates a driver row with verification fields initially set to NULL.
 * Status defaults are handled by the database.
 */
async function createDriverApplicant({ fullName, email, phone, passwordHash }) {
  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO drivers (full_name, email, phone_number, password_hash)
       VALUES (:fullName, :email, :phone, :passwordHash)`,
      { fullName, email, phone, passwordHash },
    );
  } catch (err) {
    // DB-level unique constraints are the final safeguard against race conditions.
    if (err.code === "ER_DUP_ENTRY") {
      throw new AppError(
        409,
        "DUPLICATE_FIELD",
        "One or more fields are already registered",
      );
    }
    throw err;
  }
  return findByIdForRole("driver", result.insertId);
}

async function linkGoogleIdToRider(userId, googleId) {
  await pool.query(
    "UPDATE customers SET google_id = :googleId, email_verified = TRUE WHERE user_id = :userId",
    { googleId, userId },
  );
}

/**
 * Saves verification documents and resets verification status to 'pending'.
 */
async function updateDriverVerificationDocuments(driverId, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return;

  const setClause = columns.map((col) => `${col} = :${col}`).join(", ");
  await pool.query(
    `UPDATE drivers
     SET ${setClause}, verification_status = 'pending'
     WHERE driver_id = :driverId`,
    { ...fields, driverId },
  );
}

async function updatePasswordForRole(role, id, passwordHash) {
  const cfg = getRoleConfig(role);
  if (!cfg) throw new Error(`Unknown role: ${role}`);

  await pool.query(
    `UPDATE ${cfg.table} SET password_hash = :passwordHash WHERE ${cfg.idColumn} = :id`,
    { passwordHash, id },
  );
}

module.exports = {
  findByIdentifierForRole,
  findByIdForRole,
  findByEmailForRole,
  findRiderByEmail,
  findRiderByGoogleId,
  isPhoneTaken,
  isPhoneTakenByOtherRider,
  isLicenseNumberTaken,
  isLicenseNumberTakenByOtherDriver,
  createRider,
  createDriverApplicant,
  linkGoogleIdToRider,
  updateDriverVerificationDocuments,
  updatePasswordForRole,
};
