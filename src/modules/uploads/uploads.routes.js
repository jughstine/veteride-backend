const { Router } = require("express");
const multer = require("multer");
const controller = require("./uploads.controller");
const { validateBody, validateParams, validateQuery } = require("../../middleware/validate");
const { authenticate, requireRole } = require("../../middleware/authenticate");
const env = require("../../config/env");
const schemas = require("./uploads.schemas");

const router = Router();

// Held in memory, not written to a temp path. The bytes are inspected before
// anything reaches the filesystem, so a file that is not what it claims is
// rejected without ever having been written.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.uploads.maxBytes, files: 1 },
});

router.use(authenticate);

// --- Admin only. Before /:uploadId, or "mine" and the bare path collide. ---
router.get(
  "/",
  requireRole("admin"),
  validateQuery(schemas.listQuerySchema),
  controller.listAll,
);

// --- Everything the caller uploaded. ---
router.get("/mine", controller.listMine);

// --- Uploading. Riders and drivers only; the service refuses admins. ---
router.post(
  "/",
  upload.single("file"),
  validateBody(schemas.kindSchema),
  controller.store,
);

// --- One record, and the bytes. Both go through the same ownership rule. ---
router.get(
  "/:uploadId",
  validateParams(schemas.uploadIdParams),
  controller.read,
);

router.get(
  "/:uploadId/file",
  validateParams(schemas.uploadIdParams),
  controller.readFile,
);

module.exports = router;
