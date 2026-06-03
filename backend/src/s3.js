const { v4: uuidv4 } = require("uuid");

// ─── File Storage ───
// Insurance cards are uploaded directly to Monday's file column.
// This module generates a unique key for logging/tracking purposes only.
// No local disk storage — volume has been removed to enable Railway replicas.

/**
 * Generate a unique key for an insurance card upload.
 * The actual file goes to Monday via uploadFileToMonday() in the submit flow.
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
  const key = `${patientUid}/${fileName}`;

  console.log(`[storage] Insurance card received for ${patientUid}: ${key} (${buffer.length} bytes) — uploading to Monday only`);

  return { url: null, key };
}

module.exports = { uploadInsuranceCard };
