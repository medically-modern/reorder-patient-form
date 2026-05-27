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

// ─── JWT Grant → Access Token ───

async function authenticate() {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT) {
    throw new Error("RingCentral credentials not configured (RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT)");
  }

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

  console.log("[sms] RingCentral authenticated successfully");
  return _accessToken;
}

async function getAccessToken() {
  if (_accessToken && Date.now() < _tokenExpiresAt) {
    return _accessToken;
  }
  return authenticate();
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

  const token = await getAccessToken();

  const res = await fetch(`${RC_SERVER_URL}/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      from: { phoneNumber: RC_FROM_NUMBER },
      to: [{ phoneNumber: e164To }],
      text: messageText,
    }),
  });

  if (!res.ok) {
    const body = await res.text();

    // If 401, token might have expired — retry once with fresh token
    if (res.status === 401 && _accessToken) {
      console.warn("[sms] Got 401, re-authenticating and retrying...");
      _accessToken = null;
      _tokenExpiresAt = 0;
      const freshToken = await getAccessToken();

      const retry = await fetch(`${RC_SERVER_URL}/restapi/v1.0/account/~/extension/~/sms`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${freshToken}`,
        },
        body: JSON.stringify({
          from: { phoneNumber: RC_FROM_NUMBER },
          to: [{ phoneNumber: e164To }],
          text: messageText,
        }),
      });

      if (!retry.ok) {
        const retryBody = await retry.text();
        const retryErr = new Error(`RingCentral SMS failed after re-auth (${retry.status}): ${retryBody}`);
        await notifySmsError(`SMS to ${e164To} failed after re-auth (${retry.status}): ${retryBody.slice(0, 200)}`);
        throw retryErr;
      }

      const retryData = await retry.json();
      console.log(`[sms] SMS sent to ${e164To} (after re-auth), messageId: ${retryData.id}`);
      return { success: true, messageId: retryData.id };
    }

    const smsErr = new Error(`RingCentral SMS failed (${res.status}): ${body}`);
    await notifySmsError(`SMS to ${e164To} failed (${res.status}): ${body.slice(0, 200)}`);
    throw smsErr;
  }

  const data = await res.json();
  console.log(`[sms] SMS sent to ${e164To}, messageId: ${data.id}`);
  return { success: true, messageId: data.id };
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
  buildReorderText,
  buildConfirmationText,
  smsHealthCheck,
};
