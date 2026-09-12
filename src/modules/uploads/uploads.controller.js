const fs = require("fs");
const uploadService = require("./uploads.service");
const asyncHandler = require("../../utils/asyncHandler");

const store = asyncHandler(async (req, res) => {
  const upload = await uploadService.store(req.user, req.file, req.body.kind);
  res.status(201).json({ upload });
});

const read = asyncHandler(async (req, res) => {
  res.status(200).json({ upload: await uploadService.read(req.params.uploadId, req.user) });
});

const readFile = asyncHandler(async (req, res) => {
  const file = await uploadService.readFile(req.params.uploadId, req.user);
  res.setHeader("content-type", file.mimeType);
  res.setHeader("content-length", file.sizeBytes);
  // These are somebody's identity documents. No shared cache may keep a
  // copy, and nothing may render one inline as a document in its own right.
  res.setHeader("cache-control", "private, no-store");
  res.setHeader("content-disposition", "inline");
  res.setHeader("x-content-type-options", "nosniff");
  fs.createReadStream(file.path).pipe(res);
});

const listMine = asyncHandler(async (req, res) => {
  res.status(200).json({ uploads: await uploadService.listMine(req.user) });
});

const listAll = asyncHandler(async (req, res) => {
  const uploads = await uploadService.listAll(req.user, {
    role: req.query.role,
    kind: req.query.kind,
  });
  res.status(200).json({ uploads });
});

module.exports = { store, read, readFile, listMine, listAll };
