const pool = require("../../../config/db");

/**
 * Cursor-paginated ledger results in newest-first order.
 */
async function listLedger(customerId, { limit, cursor }) {
  const params = { customerId, limit };
  let cursorClause = "";
  if (cursor) {
    cursorClause = "AND id < :cursor";
    params.cursor = cursor;
  }

  const [rows] = await pool.query(
    `SELECT id, amount_minor, type, reference_type, reference_id,
            balance_after_minor, created_at
     FROM customer_wallet_ledger
     WHERE customer_id = :customerId ${cursorClause}
     ORDER BY id DESC
     LIMIT :limit`,
    params,
  );
  return rows;
}

module.exports = { listLedger };
