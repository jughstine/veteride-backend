const pool = require("../../../config/db");

async function listByCustomer(customerId) {
  const [rows] = await pool.query(
    `SELECT id, method_type, label, is_default, created_at
     FROM customer_payment_methods
     WHERE customer_id = :customerId AND deleted_at IS NULL
     ORDER BY is_default DESC, created_at ASC`,
    { customerId },
  );
  return rows;
}

/** Returns the payment method only if it belongs to this customer -- callers use this to enforce ownership before deleting. */
async function findByIdForCustomer(id, customerId) {
  const [rows] = await pool.query(
    `SELECT id FROM customer_payment_methods
     WHERE id = :id AND customer_id = :customerId AND deleted_at IS NULL
     LIMIT 1`,
    { id, customerId },
  );
  return rows[0] || null;
}

async function softDeleteById(id, customerId) {
  await pool.query(
    `UPDATE customer_payment_methods
     SET deleted_at = NOW()
     WHERE id = :id AND customer_id = :customerId`,
    { id, customerId },
  );
}

module.exports = { listByCustomer, findByIdForCustomer, softDeleteById };
