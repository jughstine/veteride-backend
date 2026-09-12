const crypto = require("crypto");
const pool = require("../../../config/db");

const COLUMNS = `upload_id, owner_id, owner_role, kind, stored_name,
                 original_name, mime_type, size_bytes, uploaded_at`;

async function create({ ownerId, ownerRole, kind, storedName, originalName, mimeType, sizeBytes }) {
  const uploadId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO uploads (upload_id, owner_id, owner_role, kind,
                          stored_name, original_name, mime_type, size_bytes)
     VALUES (:uploadId, :ownerId, :ownerRole, :kind,
             :storedName, :originalName, :mimeType, :sizeBytes)`,
    { uploadId, ownerId, ownerRole, kind, storedName, originalName, mimeType, sizeBytes },
  );
  return findAny(uploadId);
}

/**
 * The record regardless of owner. For the service to read BEFORE deciding
 * access — never returned to a client without an authorisation check first.
 */
async function findAny(uploadId) {
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM uploads
      WHERE upload_id = :uploadId AND deleted_at IS NULL LIMIT 1`,
    { uploadId },
  );
  return rows[0] || null;
}

/**
 * Everything one person uploaded.
 *
 * Matched on role AND id together. The three id sequences are independent,
 * so `owner_id = 1` alone would return the passenger's licence photo to
 * driver 1.
 */
async function listForOwner(ownerId, ownerRole) {
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM uploads
      WHERE owner_id = :ownerId AND owner_role = :ownerRole AND deleted_at IS NULL
      ORDER BY uploaded_at DESC`,
    { ownerId, ownerRole },
  );
  return rows;
}

/** Everything, for an admin reviewing the queue. */
async function listAll({ role = null, kind = null, limit = 200 }) {
  const [rows] = await pool.query(
    `SELECT ${COLUMNS} FROM uploads
      WHERE deleted_at IS NULL
        AND (:role IS NULL OR owner_role = :role)
        AND (:kind IS NULL OR kind = :kind)
      ORDER BY uploaded_at DESC
      LIMIT :limit`,
    { role, kind, limit },
  );
  return rows;
}

/**
 * Retires the previous file in this slot.
 *
 * A driver who re-submits a licence photo should not leave the old one
 * readable: soft-deleted here, so the row survives for an audit trail while
 * every read stops returning it.
 */
async function supersede({ ownerId, ownerRole, kind, keepId }) {
  await pool.query(
    `UPDATE uploads SET deleted_at = NOW()
      WHERE owner_id = :ownerId AND owner_role = :ownerRole
        AND kind = :kind AND upload_id <> :keepId AND deleted_at IS NULL`,
    { ownerId, ownerRole, kind, keepId },
  );
}

module.exports = { create, findAny, listForOwner, listAll, supersede };
