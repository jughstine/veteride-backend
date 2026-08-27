const pool = require('../../../config/db');

async function listByCustomer(customerId) {
  const [rows] = await pool.query(
    `SELECT id, label, address, lat, lng, created_at
     FROM customer_saved_places
     WHERE customer_id = :customerId
     ORDER BY created_at DESC`,
    { customerId }
  );
  return rows;
}

async function create(customerId, { label, address, lat, lng }) {
  const [result] = await pool.query(
    `INSERT INTO customer_saved_places (customer_id, label, address, lat, lng)
     VALUES (:customerId, :label, :address, :lat, :lng)`,
    { customerId, label, address, lat, lng }
  );

  const [rows] = await pool.query(
    'SELECT id, label, address, lat, lng, created_at FROM customer_saved_places WHERE id = :id',
    { id: result.insertId }
  );
  return rows[0];
}

/** Returns the place only if it belongs to this customer -- callers use this to enforce ownership. */
async function findByIdForCustomer(id, customerId) {
  const [rows] = await pool.query(
    'SELECT id FROM customer_saved_places WHERE id = :id AND customer_id = :customerId LIMIT 1',
    { id, customerId }
  );
  return rows[0] || null;
}

async function deleteByIdForCustomer(id, customerId) {
  const [result] = await pool.query(
    'DELETE FROM customer_saved_places WHERE id = :id AND customer_id = :customerId',
    { id, customerId }
  );
  return result.affectedRows > 0;
}

module.exports = { listByCustomer, create, findByIdForCustomer, deleteByIdForCustomer };
