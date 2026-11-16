// ─── "Landline" patients: numbers RingCentral says cannot receive texts ───
// Called by the SMS verify pass (queue.js verifySmsBatch) with the patients whose reorder text
// AND its re-send both failed with a "this number can't take texts" code (CANT_TEXT_CODES).
// These are not treated as send failures. Two things happen, and the patient is NOT skipped
// next cycle (the number may start taking texts again):
//   1. "Can Text" (COLUMNS.CAN_TEXT) is set to No — the index is read from the live board, never
//      inferred — and a Monday update on the item names the exact number and the code that caused
//      it, because a patient can have more than one number saved;
//   2. one email lists every such patient in this pass, sent through Gmail as EMAIL_FROM.
//
// Email env (Railway variables): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
// EMAIL_FROM, LANDLINE_EMAIL_TO (comma-separated). Unset = no email; the list goes to ntfy instead.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const CODE_TEXT = {
  "SMS-CAR-400": "carrier does not support texting to this number",
  "SMS-CAR-411": "number is invalid, unallocated, or cannot receive texts",
};

function formatPhone(p) {
  const d = String(p || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || "unknown");
}

function describeCodes(codes) {
  return [...new Set(codes)].map(c => `${c} (${CODE_TEXT[c] || "cannot receive texts"})`).join("; ");
}

function emailConfig(env = process.env) {
  const to = (env.LANDLINE_EMAIL_TO || "").split(",").map(s => s.trim()).filter(Boolean);
  const cfg = {
    to,
    from: env.EMAIL_FROM || "",
    clientId: env.GOOGLE_CLIENT_ID || "",
    clientSecret: env.GOOGLE_CLIENT_SECRET || "",
    refreshToken: env.GOOGLE_REFRESH_TOKEN || "",
  };
  cfg.configured = !!(to.length && cfg.from && cfg.clientId && cfg.clientSecret && cfg.refreshToken);
  return cfg;
}

function updateBody(l, today) {
  return `📵 Reorder text could not be delivered to ${formatPhone(l.phone)} on ${today} — tried ${l.errorCodes.length} times. ` +
    `RingCentral: ${describeCodes(l.errorCodes)}. "Can Text" set to No because of this number (landline / can't text). ` +
    `Other numbers on this profile were not tested. The patient will still be texted next cycle.`;
}

function buildEmail(landlines, today) {
  const subject = `Landline patients - ${landlines.length} could not receive the reorder text (${today})`;
  const rows = landlines.map(l =>
    `- ${l.name} (UID ${l.uid}${l.itemId ? `, item ${l.itemId}` : ""}) - ${formatPhone(l.phone)} - ${describeCodes(l.errorCodes)}`);
  const text = [
    `These patients' reorder text failed twice (original + re-send) with a RingCentral code that means`,
    `the number cannot receive texts. Please call them to confirm their reorder.`,
    ``,
    ...rows,
    ``,
    `Each patient's "Can Text" is set to No, with an update naming the number that failed. They are not removed`,
    `from future reorder texts.`,
  ].join("\n");
  return { subject, text };
}

function mime({ from, to, subject, text }) {
  const enc = /^[\x00-\x7F]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const raw = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${enc}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf8").toString("base64"),
  ].join("\r\n");
  return Buffer.from(raw).toString("base64url");
}

async function sendGmail(cfg, subject, text, fetchFn = fetch) {
  const tok = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken, grant_type: "refresh_token",
    }),
  });
  if (!tok.ok) throw new Error(`Google token refresh failed (${tok.status})`);
  const { access_token } = await tok.json();
  if (!access_token) throw new Error("Google token refresh returned no access_token");
  const res = await fetchFn(SEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: mime({ from: cfg.from, to: cfg.to, subject, text }) }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status})`);
}

/**
 * @param {Array<{itemId?, uid, name, phone, errorCodes: string[]}>} landlines
 * @param {object} deps  {mondayQuery, notifyError, fetch, env, now} — injectable for tests
 */
async function reportLandlines(landlines, deps = {}) {
  if (!landlines || landlines.length === 0) return { noted: 0, emailed: false };
  const monday = deps.mondayQuery ? null : require("./monday");
  const mondayQuery = deps.mondayQuery || monday.mondayQuery;
  const getStatusIndexMap = deps.getStatusIndexMap || monday.getStatusIndexMap;
  const { COLUMNS, SUBSCRIPTION_BOARD_ID } = require("./config");
  const notifyError = deps.notifyError || require("./notify").notifyError;
  const env = deps.env || process.env;
  const today = (deps.now || new Date()).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });

  // 1. Note the number on each item. One failure does not stop the rest or the email.
  let noted = 0;
  let flagged = 0;
  const noteErrors = [];
  let noIndex = null;
  try {
    noIndex = (await getStatusIndexMap())?.[COLUMNS.CAN_TEXT]?.["no"];
    if (noIndex === undefined) noIndex = null;
  } catch (err) {
    noteErrors.push(`Can Text labels unreadable: ${err.message}`);
  }
  if (noIndex === null && !noteErrors.length) noteErrors.push(`"Can Text" column has no "No" label — not set`);
  for (const l of landlines) {
    if (!l.itemId) { noteErrors.push(`${l.uid}: no itemId on this message`); continue; }
    if (noIndex !== null) {
      try {
        const r = await mondayQuery(
          `mutation ($b: ID!, $id: ID!, $c: String!, $v: JSON!) { change_column_value(board_id: $b, item_id: $id, column_id: $c, value: $v) { id } }`,
          { b: String(SUBSCRIPTION_BOARD_ID), id: String(l.itemId), c: COLUMNS.CAN_TEXT, v: JSON.stringify({ index: noIndex }) });
        if (!r?.change_column_value?.id) throw new Error("Monday returned no item id");
        flagged++;
      } catch (err) {
        noteErrors.push(`${l.uid} Can Text: ${err.message}`);
      }
    }
    try {
      const r = await mondayQuery(
        `mutation ($id: ID!, $body: String!) { create_update(item_id: $id, body: $body) { id } }`,
        { id: String(l.itemId), body: updateBody(l, today) });
      if (!r?.create_update?.id) throw new Error("Monday returned no update id");
      noted++;
    } catch (err) {
      noteErrors.push(`${l.uid}: ${err.message}`);
    }
  }

  // 2. One email for the whole pass.
  const { subject, text } = buildEmail(landlines, today);
  const cfg = emailConfig(env);
  let emailed = false;
  let emailError = null;
  if (cfg.configured) {
    try { await sendGmail(cfg, subject, text, deps.fetch || fetch); emailed = true; }
    catch (err) { emailError = err.message; }
  } else {
    emailError = "email not configured (LANDLINE_EMAIL_TO / EMAIL_FROM / GOOGLE_* unset)";
  }

  if (!emailed || noteErrors.length) {
    await notifyError("Landline patients",
      `${subject}\n\n${text}` +
      (emailed ? "" : `\n\nEmail NOT sent: ${emailError}`) +
      (noteErrors.length ? `\n\nMonday write failed for: ${noteErrors.join("; ")}` : ""),
      { tags: ["telephone_receiver"] });
  }
  console.log(`[landlines] ${landlines.length} patient(s): Can Text=No on ${flagged}, ${noted} noted on Monday, email ${emailed ? "sent" : `not sent (${emailError})`}`);
  return { flagged, noted, emailed, emailError, noteErrors };
}

module.exports = { reportLandlines, buildEmail, updateBody, emailConfig, formatPhone };
