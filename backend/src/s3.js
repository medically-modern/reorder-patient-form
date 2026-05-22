const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// ─── File Storage ───
// Uses Railway persistent volume for insurance card uploads.
// Files are stored at /data/insurance-cards/<patientUid>/<uuid>.<ext>
// and served via the backend API at /files/<key>

const UPLOAD_DIR = process.env.UPLOAD_DIR || "/data/insurance-cards";

// Ensure upload directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Upload a file buffer to local persistent storage.
 * Returns the file path and a URL that can be used to retrieve it.
 *
 * @param {Buffer} buffer - File contents
 * @param {string} originalName - Original filename (e.g. "front.jpg")
 * @param {string} mimeType - MIME type (e.g. "image/jpeg")
 * @param {string} patientUid - Patient UID for folder organization
 * @returns {Promise<{url: string, key: string}>}
 */
async function uploadInsuranceCard(buffer, originalName, mimeType, patientUid) {
  const ext = originalName.split(".").pop() || "jpg";
  const fileName = `${uuidv4()}.${ext}`;
  const patientDir = path.join(UPLOAD_DIR, patientUid);
  const filePath = path.join(patientDir, fileName);
  const key = `${patientUid}/${fileName}`;

  ensureDir(patientDir);
  fs.writeFileSync(filePath, buffer);

  // Write metadata alongside the file
  const metaPath = filePath + ".meta.json";
  fs.writeFileSync(metaPath, JSON.stringify({
    originalName,
    mimeType,
    patientUid,
    uploadedAt: new Date().toISOString(),
    size: buffer.length,
  }));

  // URL will be served by the backend API
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${process.env.PORT || 3001}`;
  const url = `${baseUrl}/files/${key}`;

  console.log(`[storage] Uploaded insurance card for ${patientUid}: ${key} (${buffer.length} bytes)`);

  return { url, key };
}

/**
 * Get a file from storage.
 * @param {string} key - The file key (patientUid/filename)
 * @returns {{ buffer: Buffer, mimeType: string, originalName: string } | null}
 */
function getFile(key) {
  const filePath = path.join(UPLOAD_DIR, key);
  if (!fs.existsSync(filePath)) return null;

  const buffer = fs.readFileSync(filePath);
  let mimeType = "application/octet-stream";
  let originalName = path.basename(key);

  const metaPath = filePath + ".meta.json";
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      mimeType = meta.mimeType || mimeType;
      originalName = meta.originalName || originalName;
    } catch {}
  }

  return { buffer, mimeType, originalName };
}

module.exports = { uploadInsuranceCard, getFile, UPLOAD_DIR };
