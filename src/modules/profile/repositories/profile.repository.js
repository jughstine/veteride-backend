const pool = require("../../../config/db");

async function getProfileById(userId) {
  const [rows] = await pool.query(
    `SELECT user_id, full_name, email, phone_number, date_of_birth, total_trips,
            status, is_verified, google_id, preferred_payment_method, wallet_balance,
            password_hash, created_at
     FROM customers
     WHERE user_id = :userId AND deleted_at IS NULL
     LIMIT 1`,
    { userId },
  );
  return rows[0] || null;
}

/**
 * Partial update -- only columns present in `fields` are touched. Callers
 * are expected to have already validated/authorized the values.
 */
async function updateProfileFields(userId, fields) {
  const columns = Object.keys(fields);
  if (columns.length === 0) return;

  const setClause = columns.map((col) => `${col} = :${col}`).join(", ");
  await pool.query(
    `UPDATE customers SET ${setClause} WHERE user_id = :userId`,
    { ...fields, userId },
  );
}

async function updatePreferences(userId, { preferredPaymentMethod }) {
  const fields = {};
  if (preferredPaymentMethod !== undefined)
    fields.preferred_payment_method = preferredPaymentMethod;
  return updateProfileFields(userId, fields);
}

async function softDeleteById(userId) {
  await pool.query(
    "UPDATE customers SET deleted_at = NOW() WHERE user_id = :userId",
    { userId },
  );
}

module.exports = {
  getProfileById,
  updateProfileFields,
  updatePreferences,
  softDeleteById,
};
