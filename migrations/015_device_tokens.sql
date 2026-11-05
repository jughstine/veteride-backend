-- =====================================================================
-- 015_device_tokens.sql — where a handset's push address is kept.
-- =====================================================================
--
-- Without this table the server cannot address a phone at all, and a
-- driver whose app is not open and in front receives NOTHING: no booking
-- offer, no sound. Both in-app paths — the offer poll and the SSE stream —
-- need the app running. This is the only thing that reaches a pocket.
--
-- The app already posts to POST /me/push-token and swallows today's 404,
-- so every handset already installed starts registering the day the route
-- ships. No new APK. See docs/push-token.md.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/015_device_tokens.sql

CREATE TABLE IF NOT EXISTS device_tokens (
  token_id    CHAR(36)        NOT NULL,

  -- drivers.driver_id or customers.customer_id, read with `role`. One
  -- column rather than two nullable ones: a row always belongs to exactly
  -- one account, and the pair says which table to look in.
  user_id     BIGINT UNSIGNED NOT NULL,
  role        ENUM('rider','driver') NOT NULL,

  -- The Firebase Installation ID in firebase_messaging 17, not the old
  -- registration token. 255 because Google has never committed to a
  -- length and has changed it before.
  token       VARCHAR(255)    NOT NULL,
  platform    ENUM('android','ios') NOT NULL DEFAULT 'android',

  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (token_id),

  -- UNIQUE ON THE TOKEN ALONE, not on (user_id, token). A handset gets
  -- passed to another driver, and when it does the token must MOVE to the
  -- new account rather than ring for both. Unique per user would leave the
  -- old row in place and send that driver's offers to somebody else's
  -- phone.
  --
  --   INSERT INTO device_tokens (...) VALUES (...)
  --   ON DUPLICATE KEY UPDATE
  --     user_id = VALUES(user_id), role = VALUES(role),
  --     platform = VALUES(platform), updated_at = CURRENT_TIMESTAMP;
  --
  -- does the whole thing in one statement, which is what the app's repeat
  -- calls rely on: it posts on every sign-in and every session restore.
  UNIQUE KEY device_tokens_token_uk (token),

  -- "Every phone to ring for this account" is the only read this table
  -- has, and it runs on every notification.
  KEY device_tokens_user_idx (user_id, role)

  -- No foreign key, matching every table since 001: user_id points at two
  -- different tables depending on role, so there is nothing single to
  -- reference.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
