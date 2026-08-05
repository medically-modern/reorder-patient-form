// ─── Error Notification via ntfy.sh ───
// Sends all system errors to the ntfy.sh topic named by NTFY_TOPIC as push
// notifications. Fire-and-forget — notification failures are logged but never throw.
//
// The topic name is the ONLY access control ntfy.sh has: anyone who knows it can
// read every alert this service sends and publish forged ones into it. This repo is
// public, so the name must come from the environment and must never be committed
// here. An unset NTFY_TOPIC therefore disables notifications rather than falling
// back to a literal — a fallback in this file would be a published credential.

// NTFY_BASE selects the server. It defaults to ntfy.sh, but ntfy.sh silently drops
// packets from some Railway egress IPs — this service's included since 2026-08, which
// killed every alert here for weeks without anyone noticing — so production points
// this at the self-hosted server instead.
const NTFY_BASE = (process.env.NTFY_BASE || "https://ntfy.sh").replace(/\/+$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC || "";
const NTFY_URL = NTFY_TOPIC ? `${NTFY_BASE}/${NTFY_TOPIC}` : "";
const SERVICE_NAME = "reorder-patient-form";

// Delivery counters, surfaced on /health. Sends are deliberately fire-and-forget, so
// a broken notification path leaves no trace in the request that triggered it. That
// makes alerting the one subsystem whose failure is invisible precisely because it is
// the thing that reports failure — these counters are what make it observable.
const state = {
  sent: 0,
  failed: 0,
  consecutiveFailures: 0,
  lastOkAt: null,
  lastFailAt: null,
  lastError: null,
};

if (!NTFY_URL) {
  // Loud at startup: every send below is a silent no-op until this is set, and
  // the alerts it drops are the ones that report the service is unhealthy.
  console.warn("[notify] NTFY_TOPIC is not set — error notifications are DISABLED.");
}

// Health snapshot for /health. Reports "degraded" after a single failure rather than
// on a threshold: this channel carries every other subsystem's bad news, so one
// dropped push already means something may have gone unreported.
function notifyHealthCheck() {
  if (!NTFY_URL) {
    return { status: "disabled", reason: "NTFY_TOPIC not set" };
  }
  return {
    status: state.consecutiveFailures > 0 ? "degraded" : "ok",
    server: NTFY_BASE,
    sent: state.sent,
    failed: state.failed,
    consecutiveFailures: state.consecutiveFailures,
    lastOkAt: state.lastOkAt,
    lastFailAt: state.lastFailAt,
    lastError: state.lastError,
  };
}

/**
 * Send an error notification to ntfy.sh
 * @param {string} title - Short error title (shown as notification heading)
 * @param {string} message - Detailed error info
 * @param {Object} [opts]
 * @param {string} [opts.priority] - ntfy priority: "urgent", "high", "default", "low", "min"
 * @param {string[]} [opts.tags] - ntfy emoji tags, e.g. ["rotating_light", "warning"]
 * @param {string} [opts.uid] - Patient UID if relevant
 */
async function notifyError(title, message, opts = {}) {
  if (!NTFY_URL) return;

  const priority = opts.priority || "high";
  const tags = opts.tags || ["rotating_light"];
  const fullMessage = opts.uid
    ? `[${SERVICE_NAME}] UID: ${opts.uid}\n\n${message}`
    : `[${SERVICE_NAME}]\n\n${message}`;

  try {
    const res = await fetch(NTFY_URL, {
      method: "POST",
      headers: {
        "Title": title,
        "Priority": priority,
        "Tags": tags.join(","),
      },
      body: fullMessage,
    });
    // A non-2xx drops the alert just as completely as a network error does, but
    // fetch() resolves for both 404 and 503, so without this check an unknown
    // topic or a rejected token would be counted as delivered.
    if (!res.ok) throw new Error(`ntfy returned HTTP ${res.status}`);
    state.sent++;
    state.lastOkAt = new Date().toISOString();
    state.consecutiveFailures = 0;
  } catch (err) {
    // Never let notification failures propagate — but never let them vanish either.
    // The throw is swallowed because a failed alert must not break order
    // processing; the counters and the log line are what stop that swallow from
    // also erasing the evidence.
    state.failed++;
    state.consecutiveFailures++;
    state.lastFailAt = new Date().toISOString();
    state.lastError = err.message;
    console.error(
      `[notify] FAILED (${state.consecutiveFailures} consecutive, ${state.failed} total) ` +
        `sending "${title}" to ${NTFY_URL}: ${err.message}`
    );
  }
}

// ─── Pre-built notification helpers ───

function notifyCronError(message, uid) {
  return notifyError("Reorder Cron Error", message, {
    tags: ["rotating_light", "clock"],
    uid,
  });
}

function notifySmsError(message, uid) {
  return notifyError("SMS Send Failed", message, {
    tags: ["rotating_light", "phone"],
    uid,
  });
}

function notifyMondayError(message, uid) {
  return notifyError("Monday Write Error", message, {
    tags: ["rotating_light", "memo"],
    uid,
  });
}

function notifySubmissionError(message, uid) {
  return notifyError("Form Submission Error", message, {
    tags: ["rotating_light", "clipboard"],
    uid,
  });
}

function notifyAuthError(message) {
  return notifyError("Auth Error", message, {
    tags: ["rotating_light", "lock"],
  });
}

function notifyCronSummary(processed, errors, skipped) {
  if (errors > 0) {
    return notifyError(
      `Cron Complete: ${errors} error(s)`,
      `Processed: ${processed}, Errors: ${errors}, Skipped: ${skipped}`,
      { priority: "high", tags: ["warning", "clock"] }
    );
  }
  // Always notify — confirms the cron ran successfully
  return notifyError(
    `Reorder Cron: ${processed} sent`,
    `Processed: ${processed}, Skipped: ${skipped}, Errors: 0`,
    { priority: processed > 0 ? "default" : "low", tags: ["white_check_mark", "clock"] }
  );
}

function notifyUnhandled(type, error) {
  return notifyError(
    `Unhandled ${type}`,
    `${error.message}\n\n${error.stack || "No stack trace"}`,
    { priority: "urgent", tags: ["skull"] }
  );
}

module.exports = {
  notifyHealthCheck,
  notifyError,
  notifyCronError,
  notifySmsError,
  notifyMondayError,
  notifySubmissionError,
  notifyAuthError,
  notifyCronSummary,
  notifyUnhandled,
};
