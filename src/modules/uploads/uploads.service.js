const fs = require("fs");
const path = require("path");
const AppError = require("../../utils/AppError");
const env = require("../../config/env");
const uploadRepo = require("./repositories/upload.repository");

/**
 * Who may look at an upload.
 *
 * The whole rule, in one function, so there is exactly one place to read and
 * exactly one place to change it:
 *
 *   an admin      may see every upload
 *   anyone else   may see only their own — matched on BOTH their id and
 *                 their role, because customer 1, driver 1 and admin 1 are
 *                 three different people who happen to share a number
 *
 * Returns nothing; throws 404 rather than 403 when a non-owner asks for
 * someone else's file. 403 would confirm the file exists, which tells a
 * stranger that driver 812 has a licence photo on record. A 404 tells them
 * nothing they did not already know.
 */
function assertMayView(upload, viewer) {
  if (viewer.role === "admin") return;
  const mine =
    String(upload.owner_id) === String(viewer.id) &&
    upload.owner_role === viewer.role;
  if (!mine) throw new AppError(404, "UPLOAD_NOT_FOUND", "No such upload");
}

/** Only these, and the extension is derived from the type — never the name. */
const ACCEPTED = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
};

/** The first bytes of a file, which is what it actually is. */
const MAGIC = [
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  // RIFF....WEBP — the middle four bytes are the length, so they are skipped.
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

/**
 * What this file really is, regardless of what the client called it.
 *
 * A browser's Content-Type is a claim by the uploader. Storing a .php or an
 * .html because the request said "image/jpeg" is how an upload directory
 * becomes a way to run code or serve a phishing page from your own domain.
 */
function sniff(buffer) {
  for (const sig of MAGIC) {
    const head = sig.bytes.every((b, i) => buffer[i] === b);
    if (!head) continue;
    if (sig.at8 && !sig.at8.every((b, i) => buffer[8 + i] === b)) continue;
    return sig.mime;
  }
  return null;
}

function uploadDir() {
  const dir = env.uploads.dir;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** POST /uploads — stores one file against the caller. */
async function store(viewer, file, kind) {
  if (!file) throw new AppError(400, "NO_FILE", "No file was sent");
  if (viewer.role === "admin") {
    // An admin reviews documents; they do not have a licence of their own to
    // file here, and letting them upload as themselves would create rows no
    // rule below knows what to do with.
    throw new AppError(403, "FORBIDDEN", "Admins do not upload documents");
  }

  const real = sniff(file.buffer);
  if (!real || !ACCEPTED[real]) {
    throw new AppError(
      400,
      "UNSUPPORTED_TYPE",
      "Only JPEG, PNG, WebP and PDF files are accepted",
    );
  }
  if (file.size > env.uploads.maxBytes) {
    throw new AppError(413, "FILE_TOO_LARGE", "That file is too large");
  }

  // A generated name with an extension derived from the sniffed type. The
  // client's filename never reaches the filesystem, so it cannot contain
  // "../" or a second extension.
  const storedName = `${viewer.role}-${viewer.id}-${Date.now()}-${Math.floor(
    Math.random() * 1e9,
  )}${ACCEPTED[real]}`;

  fs.writeFileSync(path.join(uploadDir(), storedName), file.buffer, { mode: 0o600 });

  const row = await uploadRepo.create({
    ownerId: viewer.id,
    ownerRole: viewer.role,
    kind,
    storedName,
    originalName: String(file.originalname || "").slice(0, 255) || null,
    mimeType: real,
    sizeBytes: file.size,
  });

  // One current file per slot. The previous licence photo stops being
  // readable the moment a new one replaces it.
  await uploadRepo.supersede({
    ownerId: viewer.id,
    ownerRole: viewer.role,
    kind,
    keepId: row.upload_id,
  });

  return toView(row);
}

/** GET /uploads/:id — the record, for whoever may see it. */
async function read(uploadId, viewer) {
  const row = await uploadRepo.findAny(uploadId);
  if (!row) throw new AppError(404, "UPLOAD_NOT_FOUND", "No such upload");
  assertMayView(row, viewer);
  return toView(row);
}

/** GET /uploads/:id/file — the bytes, for whoever may see them. */
async function readFile(uploadId, viewer) {
  const row = await uploadRepo.findAny(uploadId);
  if (!row) throw new AppError(404, "UPLOAD_NOT_FOUND", "No such upload");
  assertMayView(row, viewer);

  // Resolved and then checked to be inside the directory. stored_name is
  // generated, so this cannot currently escape — but a path built from the
  // database should still be proven to land where it claims.
  const dir = path.resolve(uploadDir());
  const full = path.resolve(dir, row.stored_name);
  if (!full.startsWith(dir + path.sep)) {
    throw new AppError(404, "UPLOAD_NOT_FOUND", "No such upload");
  }
  if (!fs.existsSync(full)) {
    throw new AppError(410, "FILE_GONE", "That file is no longer on this server");
  }
  return { path: full, mimeType: row.mime_type, sizeBytes: row.size_bytes };
}

/** GET /uploads/mine — everything the caller uploaded. */
async function listMine(viewer) {
  if (viewer.role === "admin") return [];
  const rows = await uploadRepo.listForOwner(viewer.id, viewer.role);
  return rows.map(toView);
}

/** GET /uploads — admin only. Every upload, filterable. */
async function listAll(viewer, { role, kind }) {
  if (viewer.role !== "admin") {
    throw new AppError(403, "FORBIDDEN", "You do not have access to this resource");
  }
  const rows = await uploadRepo.listAll({ role: role ?? null, kind: kind ?? null });
  return rows.map((row) => ({ ...toView(row), owner_id: row.owner_id, owner_role: row.owner_role }));
}

/**
 * One upload as a client reads it.
 *
 * `stored_name` is deliberately absent: it is the filesystem's business, and
 * a client that knew it would be one path-traversal bug away from the rest
 * of the directory. The `url` is the only way in, and it goes through the
 * authorisation check every time.
 */
function toView(row) {
  return {
    upload_id: row.upload_id,
    kind: row.kind,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    original_name: row.original_name,
    uploaded_at: row.uploaded_at,
    url: `/uploads/${row.upload_id}/file`,
  };
}

module.exports = { store, read, readFile, listMine, listAll, assertMayView };
