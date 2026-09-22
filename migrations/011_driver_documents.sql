-- =====================================================================
-- The documents a driver actually has to file.
-- =====================================================================
--
-- `uploads.kind` was an ENUM of three: the licence, the OR/CR and the
-- profile photo. Everything else the app collects — the back of the licence,
-- the NBI clearance, the photographs of the vehicle — had nowhere on this
-- server to go, so the app told drivers those were not collected at all.
--
-- Five more names, and nothing else changes. The three that exist keep their
-- exact spelling, `license_photo` included, even though it now means the
-- FRONT of the licence specifically: rows already exist under that name and
-- renaming a kind would orphan every document filed before today.
--
-- WHY THREE VEHICLE KINDS AND NOT ONE. A reviewer matching the plate against
-- the OR/CR needs the plate on its own, not whichever of three photographs
-- happened to be uploaded last. Separate names also mean a driver who sends
-- two side photos and no plate can be told exactly what is missing.
--
-- Widening an ENUM is additive: every existing row keeps its value, and
-- nothing that reads this column has to change. MODIFY states the whole list
-- rather than appending, which is how MySQL takes it, and running this file
-- twice leaves the column in exactly the same state — the second run is a
-- no-op by definition rather than by a guard.
--
-- MySQL 8. Run once:  mysql -u USER -p DBNAME < migrations/011_driver_documents.sql

ALTER TABLE uploads
  MODIFY COLUMN kind ENUM(
    -- The licence, both sides.
    'license_photo',
    'license_back',
    -- The vehicle's registration.
    'or_cr_photo',
    -- Clearance to carry passengers.
    'nbi_clearance',
    -- The vehicle itself, so what turns up can be matched to the papers.
    'vehicle_front',
    'vehicle_side',
    'vehicle_plate',
    -- Not a document: the face passengers see. Here because it goes through
    -- the same route, and deliberately left out of the review queue so a
    -- driver is never held up over their avatar.
    'profile_photo'
  ) NOT NULL;
