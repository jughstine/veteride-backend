const crypto = require("crypto");
const pool = require("../../../config/db");

async function listForTrip(tripId, limit = 500) {
  const [rows] = await pool.query(
    `SELECT message_id, sender_role, body, sent_at
       FROM trip_messages
      WHERE trip_id = :tripId
      ORDER BY sent_at ASC, message_id ASC
      LIMIT :limit`,
    { tripId, limit },
  );
  return rows;
}

/**
 * Stores one line.
 *
 * `sender_role` and not the sender's id is what comes back out: which side
 * of the screen a message belongs on is all either phone needs, and the
 * other party's primary key is not theirs to have.
 */
async function create(tripId, { senderId, senderRole, body }) {
  const messageId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO trip_messages (message_id, trip_id, sender_id, sender_role, body)
     VALUES (:messageId, :tripId, :senderId, :senderRole, :body)`,
    { messageId, tripId, senderId, senderRole, body },
  );

  const [rows] = await pool.query(
    `SELECT message_id, sender_role, body, sent_at
       FROM trip_messages WHERE message_id = :messageId`,
    { messageId },
  );
  return rows[0];
}

module.exports = { listForTrip, create };
