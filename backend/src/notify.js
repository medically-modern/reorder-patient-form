// ─── Error Notification via ntfy.sh ───
// Sends all system errors to ntfy.sh/mm-portal as push notifications.
// Fire-and-forget — notification failures are logged but never throw.

const NTFY_TOPIC = process.env.NTFY_TOPIC || "mm-portal";
const NTFY_URL = `https://ntfy.sh/${NTFY_TOPIC}`;
const SERVICE_NAME = "reorder-patient-form";

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
  const priority = opts.priority || "high";
  const tags = opts.tags || ["rotating_light"];
  const fullMessage = opts.uid
    ? `[${SERVICE_NAME}] UID: ${opts.uid}\n\n${message}`
    : `[${SERVICE_NAME}]\n\n${message}`;

  try {
    await fetch(NTFY_URL, {
      method: "POST",
      headers: {
        "Title": title,
        "Priority": priority,
        "Tags": tags.join(","),
      },
      body: fullMessage,
    });
  } catch (err) {
    // Never let notification failures propagate
    console.error(`[notify] Failed to send ntfy notification: ${err.message}`);
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
  notifyError,
  notifyCronError,
  notifySmsError,
  notifyMondayError,
  notifySubmissionError,
  notifyAuthError,
  notifyCronSummary,
  notifyUnhandled,
};
