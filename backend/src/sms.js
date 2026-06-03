// ─── RingCentral SMS Module ───
// Uses RingCentral REST API with JWT auth to send text messages.
// Handles token acquisition, automatic refresh, and retry logic.

const RC_SERVER_URL = process.env.RC_SERVER_URL || "https://platform.ringcentral.com";
const RC_CLIENT_ID = process.env.RC_CLIENT_ID;
const RC_CLIENT_SECRET = process.env.RC_CLIENT_SECRET;
const RC_JWT = process.env.RC_JWT;
const RC_FROM_NUMBER = process.env.RC_FROM_NUMBER;
const PRODUCTION_SMS_ENABLED = process.env.PRODUCTION_SMS_ENABLED === "true";
const { notifySmsError, notifyAuthError } = require("./notify");

let _accessToken = null;
let _tokenExpiresAt = 0;
let _authPromise = null;  // Mutex: only one auth call in flight at a time
let _authCount = 0;       // Track initial vs re-auth for logging

// ─── JWT Grant → Access Token ───

async function authenticate() {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT) {
    throw new Error("RingCentral credentials not configured (RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT)");
  }

  _authCount++;
  const isReauth = _authCount > 1;
  console.log(`[sms] ${isReauth ? "Re-authenticating" : "Initial auth"} with RingCentral (auth #${_authCount})...`);

  const basicAuth = Buffer.from(`${RC_CLIENT_ID}:${RC_CLIENT_SECRET}`).toString("base64");

  const res = await fetch(`${RC_SERVER_URL}/restapi/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: RC_JWT,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    const err = new Error(`RingCentral auth failed (${res.status}): ${body}`);
    await notifyAuthError(`RC auth failed (${res.status}): ${body.slice(0, 200)}`);
    throw err;
  }

  const data = await res.json();
  _accessToken = data.access_token;
  // Refresh 60 seconds before actual expiry
  _tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

  const ttlMin = Math.round((data.expires_in - 60) / 60);
  console.log(`[sms] RingCentral authenticated — token valid for ~${ttlMin} min`);
  return _accessToken;
}

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiresAt) {
    return _accessToken;
  }

  // Mutex: if an auth call is already in flight, await it instead of firing another
  if (_authPromise) {
    console.log("[sms] Auth already in flight — waiting for existing auth call");
    return _authPromise;
  }

  _authPromise = authenticate().finally(() => { _authPromise = null; });
  return _authPromise;
}

// ─── Retry helper for transient errors ───

async function fetchWithRetry(url, options, { maxRetries = 2, label = "request" } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.ok) return res;

    const body = await res.text();

    // Retryable: 429 (rate limit) or 5xx (server error)
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) {
      // Exponential backoff: 1s, 3s
      const delay = (attempt + 1) * 1500;
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? Math.min(parseInt(retryAfter, 10) * 1000, 10000) : delay;
      console.warn(`[sms] ${label} got ${res.status}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})...`);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    // Non-retryable or exhausted retries — return the failed response + body
    return { ok: false, status: res.status, _body: body, headers: res.headers };
  }
}

// ─── Send SMS ───

/**
 * @param {string} toNumber - Patient phone number
 * @param {string} messageText - Message body
 * @param {Object} [opts] - Options
 * @param {string} [opts.patientName] - If name contains "[TEST]", sends even when production is off
 */
async function sendSMS(toNumber, messageText, opts = {}) {
  const isTestPatient = opts.patientName && opts.patientName.includes("[TEST]");

  // Safety gate — don't send real texts unless explicitly enabled OR this is a [TEST] patient
  if (!PRODUCTION_SMS_ENABLED && !isTestPatient) {
    console.log(`[sms] PRODUCTION_SMS_ENABLED=false — would send to ${toNumber}:`);
    console.log(`[sms] Message: ${messageText}`);
    return { success: true, simulated: true };
  }

  if (isTestPatient && !PRODUCTION_SMS_ENABLED) {
    console.log(`[sms] [TEST] patient bypass — sending real SMS even though production is off`);
  }

  if (!RC_FROM_NUMBER) {
    throw new Error("RC_FROM_NUMBER not configured");
  }

  // Normalize phone number to E.164
  const cleanTo = toNumber.replace(/\D/g, "");
  const e164To = cleanTo.startsWith("1") ? `+${cleanTo}` : `+1${cleanTo}`;

  const smsUrl = `${RC_SERVER_URL}/restapi/v1.0/account/~/extension/~/sms`;
  const smsBody = JSON.stringify({
    from: { phoneNumber: RC_FROM_NUMBER },
    to: [{ phoneNumber: e164To }],
    text: messageText,
  });

  const token = await getAccessToken();

  const res = await fetchWithRetry(smsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: smsBody,
  }, { label: `SMS to ${e164To}` });

  if (res.ok) {
    const data = await res.json();
    console.log(`[sms] SMS sent to ${e164To}, messageId: ${data.id}`);
    return { success: true, messageId: data.id };
  }

  const body = res._body || await res.text();

  // 401 — token expired or revoked. Force re-auth and retry once.
  if (res.status === 401) {
    console.warn("[sms] Got 401, forcing re-auth and retrying...");
    _accessToken = null;
    _tokenExpiresAt = 0;
    const freshToken = await getAccessToken();

    const retry = await fetchWithRetry(smsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${freshToken}`,
      },
      body: smsBody,
    }, { label: `SMS to ${e164To} (re-auth retry)` });

    if (retry.ok) {
      const retryData = await retry.json();
      console.log(`[sms] SMS sent to ${e164To} (after re-auth), messageId: ${retryData.id}`);
      return { success: true, messageId: retryData.id };
    }

    const retryBody = retry._body || await retry.text();
    const retryErr = new Error(`RingCentral SMS failed after re-auth (${retry.status}): ${retryBody}`);
    await notifySmsError(`SMS to ${e164To} failed after re-auth (${retry.status}): ${retryBody.slice(0, 200)}`);
    throw retryErr;
  }

  const smsErr = new Error(`RingCentral SMS failed (${res.status}): ${body}`);
  await notifySmsError(`SMS to ${e164To} failed (${res.status}): ${body.slice(0, 200)}`);
  throw smsErr;
}

// ─── Pre-formatted message builders ───

/**
 * Build the initial reorder text (sent when cron detects 20 days out).
 * @param {string} accountName - Patient's name from Monday
 * @param {string} nextOrderDate - Next order date string
 * @param {string} reorderLink - The reorder confirmation link
 */
function buildReorderText(accountName, nextOrderDate, reorderLink) {
  return [
    `Hey ${accountName}, good news - we are preparing your re-order!`,
    `The scheduled shipment date is ${nextOrderDate}.`,
    `Can you please confirm your order in the link below.`,
    ``,
    `Thanks!`,
    `Medically Modern`,
    reorderLink,
  ].join(" \n");
}

/**
 * Build the confirmation text (sent after patient submits form).
 * @param {Object} opts
 * @param {string} opts.name - Patient name
 * @param {string} opts.address - Shipping address
 * @param {string} opts.nextOrder - Ship date
 * @param {string|null} opts.sensorsType - CGM type
 * @param {string|null} opts.suppliesType - Pump type
 * @param {string|null} opts.infusionSet1 - Infusion set 1
 * @param {string|null} opts.infQty1 - Infusion set 1 qty
 * @param {string|null} opts.infusionSet2 - Infusion set 2
 * @param {string|null} opts.infQty2 - Infusion set 2 qty
 */
function buildConfirmationText(opts) {
  const lines = [
    `Hi ${opts.name}, here's a summary of what we'll be sending you:`,
    ``,
  ];

  // Items
  const items = [];
  if (opts.sensorsType) items.push(`CGM: ${opts.sensorsType}`);
  if (opts.suppliesType) items.push(`Pump Supplies: ${opts.suppliesType}`);
  if (opts.infusionSet1) {
    const qty1 = opts.infQty1 ? ` (x${opts.infQty1})` : "";
    items.push(`Infusion Set 1: ${opts.infusionSet1}${qty1}`);
  }
  if (opts.infusionSet2) {
    const qty2 = opts.infQty2 ? ` (x${opts.infQty2})` : "";
    items.push(`Infusion Set 2: ${opts.infusionSet2}${qty2}`);
  }

  if (items.length > 0) {
    lines.push(`Items:`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    lines.push(``);
  }

  if (opts.address) {
    lines.push(`Ship to: ${opts.address}`);
  }
  if (opts.nextOrder) {
    lines.push(`Scheduled ship date: ${opts.nextOrder}`);
  }

  lines.push(``);
  lines.push(`If anything looks wrong, please text or call us right away!`);
  lines.push(`- Medically Modern`);

  return lines.join("\n");
}

// ─── Check message delivery status ───

/**
 * Check the delivery status of a sent SMS via RingCentral message-store API.
 * @param {string} messageId - The RC messageId returned from sendSMS
 * @returns {{ messageId, status, to, direction, lastModifiedTime }}
 *   status is one of: Queued, Sent, Delivered, DeliveryFailed, SendingFailed
 */
async function checkMessageStatus(messageId) {
  const token = await getAccessToken();
  const url = `${RC_SERVER_URL}/restapi/v1.0/account/~/extension/~/message-store/${messageId}`;

  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  }, { label: `SMS status check ${messageId}` });

  if (res.ok) {
    const data = await res.json();
    return {
      messageId: data.id,
      status: data.messageStatus,
      to: data.to?.[0]?.phoneNumber || null,
      direction: data.direction,
      lastModifiedTime: data.lastModifiedTime,
    };
  }

  // 401 — force re-auth and retry once
  if (res.status === 401) {
    _accessToken = null;
    _tokenExpiresAt = 0;
    const freshToken = await getAccessToken();
    const retry = await fetchWithRetry(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${freshToken}` },
    }, { label: `SMS status check ${messageId} (re-auth)` });

    if (retry.ok) {
      const data = await retry.json();
      return {
        messageId: data.id,
        status: data.messageStatus,
        to: data.to?.[0]?.phoneNumber || null,
        direction: data.direction,
        lastModifiedTime: data.lastModifiedTime,
      };
    }
  }

  const body = res._body || "unknown error";
  throw new Error(`Failed to check message ${messageId} status (${res.status}): ${body.slice(0, 200)}`);
}

// ─── Health check ───

function smsHealthCheck() {
  return {
    configured: !!(RC_CLIENT_ID && RC_CLIENT_SECRET && RC_JWT && RC_FROM_NUMBER),
    productionEnabled: PRODUCTION_SMS_ENABLED,
    authenticated: !!_accessToken && Date.now() < _tokenExpiresAt,
  };
}

module.exports = {
  sendSMS,
  checkMessageStatus,
  buildReorderText,
  buildConfirmationText,
  smsHealthCheck,
};
