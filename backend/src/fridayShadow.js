/**
 * The Friday read shadow: after this service's read of Monday has Monday's answer, the same read and that answer are handed
 * to Friday's POST /v2/shadow, which runs the read on Friday's Monday-shaped /v2 and keeps how the two answers compare
 * (counts, field paths, ids and times, never a value). Settings → Reads shadowed on Friday shows each program's reads beside
 * the Command Center's: the proof that every read a program makes is answered by Friday as Monday answers it, before the day
 * its Monday address points at Friday (Josh, 2026-11-25: "work through all of them, reads need to match").
 *
 * Off the reader's way, by construction:
 *   · `onRead` is synchronous bookkeeping that never throws; the hand-off starts on the next turn of the event loop, after the
 *     caller has its answer, and nothing awaits it;
 *   · it never retries and never queues: a read it can't hand over is a count, not a backlog; at most FRIDAY_SHADOW_INFLIGHT
 *     (default 2) at a time, the rest dropped and counted; an answer over FRIDAY_SHADOW_MAX_BYTES (default 8 MB) is not sent;
 *   · OFF unless FRIDAY_SHADOW=1, with Friday's address (FRIDAY_SHADOW_URL, else FRIDAY_URL) and a key with the read scope
 *     (FRIDAY_SHADOW_KEY, else FRIDAY_API_KEY). FRIDAY_SHADOW_RATE (0..1, default 1) samples reads; FRIDAY_SHADOW_READER names
 *     the program on Friday's screen (default: the name the service passes).
 * Only reads that can touch a board Friday serves (FRIDAY_SHADOW_BOARDS, default every one): a read naming one, or naming no
 * board at all (items by id, a next page); Friday says "not compared" for the rest.
 *
 * The same file lives in every CommonJS service that reads Monday (the gateway has the ESM original, the Python services a
 * port). Change it in one, copy it to the others.
 *
 * PHI: the read and Monday's answer go to Friday, which holds the same data, and are never written down there or here; this
 * module logs counts only.
 */

/** Every Monday board Friday serves (2026-11-25), subitem boards included. */
const DEFAULT_BOARDS = [
  "18406352652", "18406060017", "18410601299", "18410804557", "18407459988", "18407459997", "18405457690", "18420366344",
  "18420767820", "18434666323", "18142847597", "18245429780", "18245429979", "18413019028", "18413019033", "18415763041",
  "18415763667", "18440378634", "18440223200",
];

/** Does this read touch a board Friday serves (or name no board at all)? Pure. */
function touchesFriday(query, variables, boards = DEFAULT_BOARDS) {
  const q = String(query || "");
  if (!q.trim() || /^\s*mutation\b/i.test(q)) return false;
  let vars = "";
  try { vars = JSON.stringify(variables ?? {}); } catch { vars = ""; }
  const text = q + " " + vars;
  if (boards.some((b) => text.includes(String(b)))) return true;
  // a read naming no board: items by id, a next page from a cursor
  return !/\bboards\s*\(/.test(q) && !/\bboard_id\s*:/.test(q) && /\b(items|next_items_page)\s*\(/.test(q);
}

function createFridayShadow({ env = process.env, log = console.log, fetchImpl = globalThis.fetch, random = Math.random, reader = null } = {}) {
  const url = String(env.FRIDAY_SHADOW_URL || env.FRIDAY_URL || "").replace(/\/+$/, "");
  const key = String(env.FRIDAY_SHADOW_KEY || env.FRIDAY_API_KEY || "");
  const enabled = env.FRIDAY_SHADOW === "1" && Boolean(url) && Boolean(key) && typeof fetchImpl === "function";
  const why = env.FRIDAY_SHADOW !== "1" ? "FRIDAY_SHADOW is not 1" : !url ? "no Friday address (FRIDAY_SHADOW_URL / FRIDAY_URL)" : !key ? "no Friday key (FRIDAY_SHADOW_KEY / FRIDAY_API_KEY)" : !enabled ? "no fetch" : null;
  const rate = Math.min(Math.max(Number(env.FRIDAY_SHADOW_RATE ?? 1), 0), 1);
  const maxInflight = Math.max(1, Number(env.FRIDAY_SHADOW_INFLIGHT) || 2);
  const maxBytes = Math.max(1, Number(env.FRIDAY_SHADOW_MAX_BYTES) || 8 * 1024 * 1024);
  const boards = String(env.FRIDAY_SHADOW_BOARDS || DEFAULT_BOARDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const label = String(env.FRIDAY_SHADOW_READER || reader || "").slice(0, 80) || null;
  const stats = { handed: 0, same: 0, differs: 0, friday_error: 0, not_compared: 0, mid_edit: 0, kept: 0, cutover: 0, failed: 0, dropped_busy: 0, dropped_size: 0, sampled_out: 0, not_friday: 0 };
  let inflight = 0;
  const pending = new Set();   // the hand-offs on their way, for flush()

  /**
   * After a Monday read was answered: hand it to Friday, or count why not. Never throws, never awaited by the caller.
   * `text` is Monday's answer as it came (preferred: spliced in whole); `json` the caller's parse of it (sent re-encoded when
   * there is no text). `status` and `ms` are Monday's HTTP status and how long it took.
   */
  function onRead({ query, variables, operationName = null, apiVersion = null, status = 200, text = null, json = null, ms = null } = {}) {
    try {
      if (!enabled) return;
      if (!touchesFriday(query, variables, boards)) { stats.not_friday++; return; }
      if (random() >= rate) { stats.sampled_out++; return; }
      if (inflight >= maxInflight) { stats.dropped_busy++; return; }
      if (typeof text === "string" && text.length > maxBytes) { stats.dropped_size++; return; }
      if (typeof text !== "string" && (!json || typeof json !== "object")) { stats.failed++; return; }
      inflight++;
      let done;
      const p = new Promise((r) => { done = r; });
      pending.add(p);
      setImmediate(() => send({ query, variables, operationName, apiVersion, status, text, json, ms }, () => { pending.delete(p); done(); }));
    } catch { stats.failed++; }
  }

  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  function send({ query, variables, operationName, apiVersion, status, text, json, ms }, finished = () => {}) {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), 30_000);
    Promise.resolve()
      .then(() => {
        let answer = text;
        if (typeof answer !== "string") answer = JSON.stringify(json);
        if (typeof answer !== "string" || answer.length > maxBytes) { stats.dropped_size++; return null; }
        const body = '{"query":' + JSON.stringify(String(query ?? "")) + ',"variables":' + JSON.stringify(variables || {}) + ',"operationName":' + JSON.stringify(operationName ?? null)
          + ',"api_version":' + JSON.stringify(apiVersion ?? null) + ',"reader":' + JSON.stringify(label)
          + ',"monday":{"status":' + num(status) + ',"ms":' + num(ms) + ',"body":' + answer + "}}";
        return fetchImpl(`${url}/v2/shadow`, { method: "POST", signal: ctrl?.signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body });
      })
      .then(async (r) => {
        if (!r) return;
        stats.handed++;
        if (!r.ok) { stats.failed++; return; }
        const j = await r.json().catch(() => ({}));
        if (j && j.outcome && j.outcome in stats) stats[j.outcome]++;
      })
      .catch(() => { stats.failed++; })
      .finally(() => { clearTimeout(timer); inflight--; finished(); });
  }

  /** Wait (at most `timeoutMs`) for hand-offs on their way: for a program that exits when its run is done. Never rejects. */
  function flush(timeoutMs = 10_000) {
    if (!pending.size) return Promise.resolve();
    let t;
    return Promise.race([Promise.allSettled([...pending]), new Promise((r) => { t = setTimeout(r, timeoutMs); })]).finally(() => clearTimeout(t));
  }

  /** What /health shows: on or off and why, the sampling, and the counts. */
  function health() { return { enabled, why, reader: label, rate, max_inflight: maxInflight, inflight, boards: boards.length, stats: { ...stats } }; }
  if (!enabled) { try { log(`[friday-shadow] off (${why})`); } catch { /* never throws */ } }
  else { try { log(`[friday-shadow] on: ${label || "unlabelled"}, rate ${rate}, ${boards.length} boards`); } catch { /* never throws */ } }
  return { onRead, health, flush, stats: () => ({ ...stats, inflight }), enabled };
}

module.exports = { createFridayShadow, touchesFriday, DEFAULT_BOARDS };
