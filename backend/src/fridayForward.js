/**
 * The Friday forward: every mutation Monday accepted from this service is handed to Friday
 * afterwards, exactly as it was sent to Monday (the query, its variables, Monday's answer), at
 * Friday's POST /v1/monday/write; every file Monday accepted is handed to Friday's file upload.
 * Friday turns each into its own write on its copy of the board, keyed by Monday's item id.
 *
 * Additive, by construction (Josh, 2026-10-12: "additive, nothing can drop that wouldn't have
 * in the first place"; 2026-10-13: "if things fail going into Friday, no big deal, ntfy, forget
 * about it"):
 *   · nothing here runs before Monday's answer, and nothing here can change it: `onMutation` and
 *     `onFile` are synchronous bookkeeping that never throw, and the sending happens later, on a
 *     timer, in this process;
 *   · the queue is in memory, drained in order, one request at a time, so Friday sees a patient's
 *     create before the writes that follow it; a row is retried with backoff and then given up on,
 *     with one alert; a restart loses what was queued, and Friday's hourly board check and its
 *     Monday load are the safety net for that;
 *   · OFF unless FRIDAY_FORWARD=1 with FRIDAY_URL and FRIDAY_API_KEY set.
 *
 * The same file lives in dtc-mm-form-api, manufacturer-referral-webhook and fax-intake (ESM) and, as this
 * CommonJS twin, in josh-monday-automations, auto-doctor-database-search and reorder-patient-form (the Command Center gateway has its
 * own, Postgres-backed; stedi-monday-integration and the OOP estimator carry the Python port). Change it in one,
 * copy it to the others.
 *
 * PHI: a queued row holds the mutation or the file until it is delivered, in this process only.
 * Nothing here logs a value, a name or a file name: ids, counts and Friday's error text only.
 */
const { randomUUID } = require("node:crypto");

/** The boards whose writes Friday takes today: Profile Send Off. */
const DEFAULT_BOARD_IDS = ["18406352652"];
const DEFAULT_BOARD = "profile_send_off";
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
const AUTH_RETRY_MS = 10 * 60_000;
const MAX_QUEUED = 1_000;
const MAX_QUEUED_BYTES = 96 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

const isMutation = (query) => /^\s*mutation\b/i.test(String(query || ""));

/** The board a document names, from its variables or its text; null when it names none. */
function boardIdOf(query, variables) {
  const v = variables && typeof variables === "object" ? variables : {};
  for (const k of ["boardId", "board_id", "board", "b"]) {
    const x = v[k];
    if (x != null && x !== "" && /^\d{6,}$/.test(String(x))) return String(x);
  }
  const m = String(query || "").match(/\bboard_id\s*:\s*"?(\d{6,})/i);
  return m ? m[1] : null;
}

/** A mutation, on a board Friday holds (or one that names no board: Friday ignores an item it lacks). */
function shouldForward({ query, variables, boardIds = DEFAULT_BOARD_IDS }) {
  if (!isMutation(query)) return false;
  const b = boardIdOf(query, variables);
  return b == null || boardIds.includes(b);
}

/**
 * done   2xx                                 the row is delivered
 * auth   401 / 403                           the key is wrong or revoked: wait, alert, never give up
 * dead   400 / 404 / 409 / 413 / 422         Friday read it and refused it; a retry would say the same
 * retry  anything else (5xx, 429, no answer) back off, then dead after MAX_ATTEMPTS
 */
function classify(status) {
  if (status >= 200 && status < 300) return "done";
  if (status === 401 || status === 403) return "auth";
  if ([400, 404, 409, 413, 422].includes(status)) return "dead";
  return "retry";
}

const nextDelayMs = (attempts) => (attempts >= MAX_ATTEMPTS ? null : RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] ?? RETRY_DELAYS_MS[0]);

/** Friday's counts from its answer, never a value. */
function summarize(json) {
  const n = (k) => (Number.isFinite(Number(json?.[k])) ? Number(json[k]) : 0);
  if (Array.isArray(json?.files)) return { files: json.files.length };
  const skipped = (json?.operations || []).flatMap((o) => [
    ...(o.status === "skipped" ? [{ op: o.mutation, reason: String(o.reason || "").slice(0, 200) }] : []),
    ...((o.columns || []).filter((c) => c.status === "skipped").map((c) => ({ op: o.mutation, column: c.column || c.monday_column_id, reason: String(c.reason || "").slice(0, 200) }))),
  ]).slice(0, 20);
  return { applied: n("applied"), skipped: n("skipped"), ignored: n("ignored"), problems: n("problems"), ...(skipped.length ? { detail: skipped } : {}) };
}

function errorText(status, json) {
  const m = json?.error?.message || json?.error || json?.message || "";
  return `HTTP ${status}${m ? `: ${String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 300)}` : ""}`;
}

/** The built-in alert: a push to NTFY_URL (or NTFY_BASE) / NTFY_TOPIC when both are set; otherwise nothing. */
function ntfyAlert(env = process.env, fetchImpl = globalThis.fetch) {
  const base = String(env.NTFY_URL || env.NTFY_BASE || "").replace(/\/+$/, "");
  const topic = String(env.NTFY_TOPIC || "");
  if (!base || !topic) return null;
  return async (title, body) => {
    const res = await fetchImpl(`${base}/${encodeURIComponent(topic)}`, {
      method: "POST", headers: { Title: String(title).replace(/[^\x20-\x7e]/g, "?").slice(0, 120), Priority: "default", Tags: "warning" },
      body: String(body).slice(0, 2000), signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  };
}

/**
 * `service` names this process in the idempotency keys and the alerts. `alert(title, body)` is
 * awaited, caught and throttled to one an hour per kind; it defaults to the ntfy push above.
 */
function createFridayForward({
  env = process.env, log = console.log, alert = undefined, fetchImpl = globalThis.fetch, service = "service", now = () => Date.now(),
} = {}) {
  const url = String(env.FRIDAY_URL || "").replace(/\/+$/, "");
  const key = String(env.FRIDAY_API_KEY || "");
  const board = String(env.FRIDAY_BOARD || DEFAULT_BOARD);
  const boardIds = String(env.FRIDAY_BOARD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const boards = boardIds.length ? boardIds : DEFAULT_BOARD_IDS;
  const enabled = env.FRIDAY_FORWARD === "1" && Boolean(url) && Boolean(key);
  const why = env.FRIDAY_FORWARD !== "1" ? "FRIDAY_FORWARD is not 1" : !url ? "FRIDAY_URL unset" : !key ? "FRIDAY_API_KEY unset" : null;
  const sendAlert = alert === undefined ? ntfyAlert(env, fetchImpl) : alert;
  const alerts = new Map();
  const queue = [];
  let bytesQueued = 0, seq = 0, timer = null, busy = false;
  const stats = { queued: 0, delivered: 0, files_delivered: 0, problems: 0, dead: 0, auth: 0, retries: 0, dropped: 0 };

  async function raise(kind, title, body) {
    try {
      if (!sendAlert) return;
      const t = now();
      if (alerts.get(kind) && t - alerts.get(kind) < 3_600_000) return;
      alerts.set(kind, t);
      await sendAlert(`${service}: ${title}`, body);
    } catch (e) { log(`[friday-forward] alert failed: ${e.message}`); }
  }

  function push(row) {
    if (queue.length >= MAX_QUEUED || bytesQueued + (row.bytes?.length || 0) > MAX_QUEUED_BYTES) {
      stats.dropped++;
      log(`[friday-forward] queue full (${queue.length} rows, ${bytesQueued} bytes): dropped a ${row.kind} for item ${row.itemId ?? "?"}`);
      raise("full", "the Friday forward's queue is full", `${queue.length} rows and ${bytesQueued} bytes waiting; a ${row.kind} was dropped. Is Friday answering? Friday's Monday load picks up what is missing.`);
      return false;
    }
    row.id = ++seq; row.attempts = 0; row.next_at = 0; row.idem = `${service}-${randomUUID()}`;
    queue.push(row); bytesQueued += row.bytes?.length || 0; stats.queued++;
    schedule(0);
    return true;
  }

  /** A mutation Monday accepted: `data` is Monday's answer's `data` (a create_item's new id lives there). Never throws. */
  function onMutation({ query, variables, data, actor, itemId } = {}) {
    try {
      if (!enabled || !shouldForward({ query, variables, boardIds: boards })) return false;
      return push({ kind: "write", query: String(query), variables: variables && typeof variables === "object" ? variables : {}, data: data && typeof data === "object" ? data : null, actor: actor || null, itemId: itemId ?? null });
    } catch (e) { log(`[friday-forward] onMutation: ${e.message}`); return false; }
  }

  /** A file Monday accepted on an item: `column` is the Monday column id (Friday takes either name), `bytes` a Buffer. Never throws. */
  function onFile({ itemId, column, filename, contentType, bytes } = {}) {
    try {
      if (!enabled) return false;
      if (!itemId || !column || !bytes?.length) return false;
      if (bytes.length > MAX_FILE_BYTES) { log(`[friday-forward] file for item ${itemId} is ${bytes.length} bytes, over the ${MAX_FILE_BYTES} limit: not forwarded`); return false; }
      return push({ kind: "file", itemId: String(itemId), column: String(column), filename: String(filename || "file"), contentType: String(contentType || "application/octet-stream"), bytes });
    } catch (e) { log(`[friday-forward] onFile: ${e.message}`); return false; }
  }

  async function deliver(row) {
    const headers = { authorization: `Bearer ${key}`, "idempotency-key": row.idem, "user-agent": `${service}/friday-forward` };
    if (row.actor && /^[^\s@]+@medicallymodern\.com$/i.test(row.actor)) headers["x-friday-actor"] = row.actor.toLowerCase();
    let res;
    if (row.kind === "write") {
      headers["content-type"] = "application/json";
      res = await fetchImpl(`${url}/v1/monday/write`, { method: "POST", headers, body: JSON.stringify({ query: row.query, variables: row.variables, data: row.data }), signal: AbortSignal.timeout(20_000) });
    } else {
      const form = new FormData();
      form.append("files", new Blob([row.bytes], { type: row.contentType }), row.filename);
      res = await fetchImpl(`${url}/v1/boards/${board}/items/${row.itemId}/files/${row.column}`, { method: "POST", headers, body: form, signal: AbortSignal.timeout(60_000) });
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* classified by status */ }
    return { status: res.status, json };
  }

  /** One pass over the head of the queue. Returns what happened, for the loop and the tests. */
  async function tick() {
    if (!enabled) return { skipped: why };
    const row = queue[0];
    if (!row) return { idle: true };
    if (row.next_at > now()) return { waiting: row.next_at - now() };
    row.attempts++;
    let status = 0, json = null, err = null;
    try { ({ status, json } = await deliver(row)); } catch (e) { err = e; }
    const kind = err ? "retry" : classify(status);
    const finish = () => { queue.shift(); bytesQueued -= row.bytes?.length || 0; };
    if (kind === "done") {
      const summary = summarize(json);
      finish();
      if (row.kind === "file") stats.files_delivered++; else stats.delivered++;
      if (summary.problems) { stats.problems += summary.problems; log(`[friday-forward] #${row.id} (item ${row.itemId ?? "?"}): ${summary.problems} problem(s); Friday lists them under Settings → Writes from Monday's writers`); }
      return { id: row.id, done: true, summary };
    }
    const error = err ? `no answer: ${String(err.message || err).slice(0, 200)}` : errorText(status, json);
    if (kind === "dead" || (kind === "retry" && row.attempts >= MAX_ATTEMPTS)) {
      finish();
      stats.dead++;
      log(`[friday-forward] #${row.id} (${row.kind}, item ${row.itemId ?? "?"}) given up after ${row.attempts} tr${row.attempts === 1 ? "y" : "ies"}: ${error}`);
      raise("dead", "a Friday forward gave up", `${row.kind} #${row.id} for item ${row.itemId ?? "?"} after ${row.attempts} tries: ${error}. Monday has it; Friday does not. Friday's board check will list it, and its Monday load picks it up.`);
      return { id: row.id, dead: true, error };
    }
    const delay = kind === "auth" ? AUTH_RETRY_MS : nextDelayMs(row.attempts);
    row.next_at = now() + delay;
    if (kind === "auth") { stats.auth++; raise("auth", "Friday refused this service's key", `${error}. FRIDAY_API_KEY on this service needs a valid Friday key; the forward waits and retries every ${AUTH_RETRY_MS / 60000} minutes.`); }
    else stats.retries++;
    return { id: row.id, retry: true, in: delay, error };
  }

  function schedule(ms) {
    if (!enabled || timer) return;
    timer = setTimeout(async () => {
      timer = null;
      if (busy) { schedule(1_000); return; }
      busy = true;
      let wait = null;
      try {
        for (let n = 0; n < 50; n++) {
          const r = await tick();
          if (r.idle || r.skipped) break;
          if (r.waiting) { wait = r.waiting; break; }
          if (r.retry) { wait = r.in; break; }
        }
      } catch (e) { log(`[friday-forward] ${e.message}`); wait = 5_000; }
      finally { busy = false; }
      if (queue.length) schedule(wait == null ? 0 : Math.max(50, Math.min(wait, AUTH_RETRY_MS)));
    }, Math.max(0, ms));
    timer.unref?.();
  }

  function stop() { if (timer) clearTimeout(timer); timer = null; }
  const status = () => ({ enabled, reason: enabled ? null : why, url: url || null, boards, queued_now: queue.length, bytes_now: bytesQueued, ...stats });

  if (enabled) log(`[friday-forward] on: forwarding accepted mutations on board(s) ${boards.join(", ")} and files to ${url}`);
  else log(`[friday-forward] off (${why})`);
  return { enabled, why, onMutation, onFile, tick, stop, status, stats, queue };
}

module.exports = { DEFAULT_BOARD_IDS, DEFAULT_BOARD, RETRY_DELAYS_MS, MAX_ATTEMPTS, AUTH_RETRY_MS, MAX_QUEUED, MAX_QUEUED_BYTES, MAX_FILE_BYTES, isMutation, boardIdOf, shouldForward, classify, nextDelayMs, summarize, errorText, ntfyAlert, createFridayForward };
