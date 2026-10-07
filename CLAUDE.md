# CLAUDE.md — reorder-patient-form

The **20-day reorder confirmation form** for **Medically Modern**, a diabetes-supplies / DME
provider. Twenty days before a subscription's next order is due, a patient is texted a link;
they confirm, edit or postpone the order; the answer is written back to Monday.com.

**Monday is the database.** There is no other store — Redis holds tokens, queues and locks only.

Everything here was read from this repo's own source. Re-verify against the code before trusting
a detail; nothing below is from memory.

---

## 1. Two halves, one repo

| | Frontend | Backend |
|---|---|---|
| lives in | `docs/` | `backend/` |
| stack | **vanilla HTML/CSS/JS, NO build step** | Node 20 + Express |
| served from | **GitHub Pages** at `reorder.medicallymodern.com` (`docs/CNAME`) | **Railway**, `reorder-patient-form-production.up.railway.app` |
| deployed by | a push to `main` — there is **no `.github/` directory**; Pages serves `docs/` via the repo's own Settings | `backend/railway.toml` (nixpacks, healthcheck `/health`) |

⚠️ **`docs/app.js` hardcodes the backend URL** (`API_BASE`, top of file): localhost when the
hostname is `localhost`, the Railway URL otherwise. Moving the backend means editing that line.

⚠️ **No build step is a constraint, not an oversight.** `docs/index.html` loads `app.js` and
`oopEstimator.js` with plain `<script src>` tags. Anything you add there must run in a browser
as-is — no imports, no JSX, no TypeScript, no bundler. A change that needs one is a much bigger
change than it looks.

---

## 2. ⚠️ The OOP estimate is READ here, never computed — the Stedi backend owns the number

Since 2026-10 **`medicallymodern1/stedi-monday-integration`** (the Stedi backend, Python, Railway)
does ALL out-of-pocket math — benefit resolution from the 271, every payer rule / tier / carve-out,
the rate table, the estimate — and writes the result to Monday. This repo is a **reader**. The
contract (column ids, value formats, the `/oop/estimate` call, rendering rules) is the backend's
`READER_CONTRACT.md`; the column ids are mirrored in `backend/src/config.js` as `COLUMNS.BNF_*`.

**What this means in code:**

- `backend/src/oopEstimator.js` is a reader module: `parseEstimateText(text)` for the formats the
  backend writes, `readBenefitsSnapshot(col)` for the benefits columns, `fetchBackendEstimate()`
  for `POST {STEDI_BACKEND_URL}/oop/estimate` (header `X-Admin-Key`), 6s timeout, clean
  `{ok:false, reason}` on failure. `docs/oopEstimator.js` is the browser copy of
  `parseEstimateText` only — plain script, no modules. They are no longer mirrors of each other
  and carry **no rate table, no payer set, no arithmetic**.
- `backend/src/benefitsFlags.json` is a **generated snapshot** of the backend export
  (`exports/payer_policy.json` → `flags`, `versions`): flag code → text + confidence. Never
  hand-edit it; replace it from a fresh export.
- ⚠️ **`npm test` fails the build if any of it comes back.** `backend/test/noMath.test.js` scans
  `backend/src` and `docs/` for `PAYER_RATE_SCHEDULE`, `ZERO_OOP_PAYERS`, `PRIMARY_MEDICAID_LABELS`,
  `COINSURANCE_OVERRIDES`, any `new Set([...])` of payer labels, and any write to the OOP Estimate
  column. If a payer looks wrong, the fix is in the backend, not here.
- ⚠️ **Blank is blank.** A blank column or a `null` money field means *unknown* and renders as
  "Need benefits" / nothing — never `$0`. `$0` (a who-pays rule: Medicaid, QMB, zero-OOP payer,
  covering secondary) and `$0.00` (priced at zero) are different values and are told apart.

**Estimate text formats** (`parseEstimateText` → `kind`): `$228.75` → `amount`,
`$228.75-$533.75` → `range`, `$0` → `zero`, `$0.00` → `amount` 0, `Need benefits` →
`needBenefits`, blank → `unwritten`. Legacy text from the retired in-repo estimator
("Incomplete benefits data", "Error: …", "N/A") still sits on rows the backend has not
rewritten; it parses as `needBenefits` / `unwritten`, never as a number.

**History, for anyone who finds the old layout in git:** until 2026-10 this repo carried its own
estimator in two byte-identical files, as one of four copies of the payer policy across three
repos, cross-checked by `command-center-test`'s `scripts/check-payer-policy.mjs`. That check
read the files that no longer exist; if it is still pointed at this repo it needs retiring there.
The copies drifted twice (Aetna Medicare, NYSHIP) and quoted real members real money, which is why
there is now exactly one estimator.

---

## 3. The board and the columns

**Subscription Board `18407459988`.** Every column ID is in `backend/src/config.js` — that file is
the contract, and IDs are what survive a rename on Monday. Notable ones:

- `DAYS_TO_ORDER` `color_mkxmtv9c` — the cron's trigger; it looks for the literal **"20 Days"**.
- `REORDER_TOKEN` / `REORDER_LINK` / `REORDER_TEXT_SENT` — the link and the send-once stamp.
- `OOP_ESTIMATE` `text_mm404p7d` — the **Recurring OOP** (consumables only, deductible treated as
  met). **Written by the Stedi backend; READ-ONLY here.** The same backend writes the
  `BNF_*` benefits columns next to it (`text_bnf_*`, `color_bnf_confidence`,
  `dropdown_bnf_flags`). `BNF_VERSION` blank = the backend has not resolved that row yet.
- `PATIENT_ORDER_RESPONSE` `color_mm3kjykc` — Confirm=0 / Delay=1 / Cancel=2 (`ORDER_RESPONSE_INDEX`).

⚠️ **Status columns are written by INDEX, and Monday assigns those indexes itself** — it takes the
lowest free slot when a label is created, not display order. A write to an index the column does
not have is accepted at **HTTP 200 and dropped**, with nothing in the logs. `getStatusIndexMap()`
in `monday.js` reads them from the live board for this reason; `backend/src/checkLabels.js`
(`npm run check:labels`) audits them. **Never infer an index.**

⚠️ **Patients are routed by Monday `itemId`, NOT by UID** (commit `f47556c`). UID is display only.

### How the form gets its number — `GET /api/oop-estimate?infusionSets=N`

Session-authenticated like every other `/api/*` route (the JWT's `itemId`). The handler
(`backend/src/oopEstimateRoute.js`) asks the Stedi backend first and falls back to Monday only
when it cannot:

1. `POST {STEDI_BACKEND_URL}/oop/estimate` with `{"board":"subscription","item_id":…,
   "infusion_sets":N}` → `source: "backend"`, `quantityAware: true`. The backend's answer is
   final, including "Need benefits".
2. Only when the backend is **unavailable** (not configured, timeout, network, non-2xx,
   malformed): the row's `OOP_ESTIMATE` column parsed with `parseEstimateText` →
   `source: "column"`, `quantityAware: false` (it is the row's stored quantity, not the form's).

Response: `{ok, source, kind, text, low, high, patientPaysNothing, zeroReason, confidence,
flags[], flagText[], needsBenefits[], quantityAware, present}`. `ok:false` only when there is
nothing to show (kind `unwritten`) — the form then hides the card, exactly as it did before for
an incomplete estimate.

`docs/app.js` `getOopEstimate()` calls the route, **debounced** 300ms on stepper taps and
**cached per quantity**; `renderOopEstimate()` shows the amount / `$low–$high` / `$0` + reason /
"Need benefits", the confidence line, and each flag's text folded under "Why this estimate".
**CareCentrix referrals and Horizon BCBS** still get no estimate card (unchanged). Inactive /
Medicare Advantage rows still get the insurance-changed warning instead.

Env (Railway variables, in `.env.example`): **`STEDI_BACKEND_URL`**, **`STEDI_ADMIN_KEY`**.
Unset = column fallback only; `/health` says `stediBackend: not configured`.

### The OOP webhooks are RETIRED

From 2026-09-30 to 2026-10 this repo recomputed `OOP_ESTIMATE` itself whenever one of ten
input columns changed, via a Monday webhook per column → `POST /webhooks/monday/oop-inputs`, a
`reorder-oop-refresh` BullMQ queue, and an admin backfill. All of that is gone:

- `refreshOopEstimate`, `startOopRefreshWorker`, `enqueueOopRefresh`, `enqueueOopBackfill` still
  exist by name so `queue.js` / `index.js` / scripts load, but they **log once and do nothing**.
  No Queue is created, so a stale job in Redis is never picked up.
- `POST /webhooks/monday/oop-inputs` answers `200 {ok:true, retired:true}` (and still echoes
  Monday's `challenge`) so the board's leftover webhooks do not retry. `OOP_WEBHOOK_SECRET` is
  no longer read.
- `POST /admin/refresh-oop-estimates` answers `200 {retired:true}` and writes nothing. Refresh
  or backfill the column from the Stedi backend.
- ⚠️ **The webhooks still live on the board until someone deletes them.** `npm run
  check:oop-webhooks` now lists any left on the former input columns
  (`RETIRED_OOP_WEBHOOK_COLUMNS`, `config.js`) and exits 0; `-- --delete` removes them. Monday
  does not expose a webhook's URL, so it matches by column — check the board's Integrations view
  first if another integration might watch the same columns.

---

## 4. The cron, and the gate that stops it texting everybody

`backend/src/cron.js` — **daily at 2:00 PM ET** (`"0 14 * * *"`, `timezone: "America/New_York"`).
It only discovers patients and enqueues them; the worker does the tokens, writes and SMS.

⚠️ **`PRODUCTION_SMS_ENABLED` is the live-fire switch.** While it is not `"true"`, the cron and
`sms.js` skip every patient whose Monday item name does not contain **`[TEST]`**. That is the only
thing standing between a code change and texting the whole subscriber base. Check it before
assuming a quiet run means quiet code.

⚠️ **Replica-safe by a Redis leader lock** — only one replica runs the cron. Patients already
carrying `REORDER_TEXT_SENT` are skipped, so a re-run does not double-text.

Four BullMQ queues (`backend/src/queue.js`): `reorder-monday-writes`, `reorder-patient-process`,
`reorder-confirmation-sms` and `reorder-sms-verify` (`reorder-oop-refresh` is retired — §3).
`reorder-sms-verify` re-reads RingCentral ~10 minutes later to confirm messages actually went out
— **an accepted SMS is not a delivered SMS**.

---

## 5. Auth — a direct, reusable token

`backend/src/auth.js`. No magic-link round trip: the link carries the token, the token mints a
24-hour JWT session. Token is 32 bytes / 64 hex chars with a **20-day TTL** matching the reorder
window, stored in **both Redis and Monday** so a Redis flush does not strand a patient
(`lookupTokenInMonday`).

⚠️ **The token is REUSABLE within its TTL** — it is not spent on first click. Re-submission is
guarded separately: a Redis submission lock, `hasSubmitted`/`markSubmitted`, and an
`X-Idempotency-Key` header on `POST /api/submit` so a network retry cannot double-write.

---

## 6. Stock — the form must not offer what Cardinal cannot ship

`backend/src/skuStatus.js` reads the **Cardinal SKU Tracker board `18420366344`**, populated by a
poller each morning at 9:05 ET. Two things in the join are load-bearing and documented in that
file's own header:

1. ⚠️ **Names are not unique board-wide.** "Mobi", "iLet", "t:slim" and "Minimed 780G" each exist
   twice — once as a pump, once as a cartridge — with different SKUs and independently moving
   stock. **The lookup key must include the group**, or you get whichever row the API serialised
   first.
2. ⚠️ One product is spelled `Mio Advance Clear 9mm 23"` there and `9 mm` on the Subscription
   board; the normaliser handles the spacing.

Cached 15 minutes; a failed read caches for 60s instead of poisoning the good copy, and data older
than **48 hours** is treated as untrustworthy rather than shown as fact.

---

## 7. Conventions & gotchas

- **Push to `main`.** No feature branches or PRs unless asked.
- **Tests:** `cd backend && npm test` (`node --test`, no extra dependency). They cover the OOP
  reader, the estimate route's fallback, and the no-math scan (§2); they need no Redis, Monday or
  network. Keep them that way.
- **PHI is everywhere.** Patient data is on every board and in every payload. Don't put it in
  logs, commits, tests or artifacts.
- ⚠️ **Monday returns HTTP 200 with an `errors[]` body on a rejected write.** Nothing throws. A
  bulk job that does not read `errors[]` will report a clean run having written nothing.
- ⚠️ **Patient data is deliberately NOT cached** (`docs/CACHE-LOGIC.md`): a 15-minute Redis cache
  was removed because staff would fix something in Monday and the patient would still see the old
  value. Don't reintroduce one without reading that file.
- **Alerts go to ntfy** (`backend/src/notify.js`). ⚠️ `NTFY_TOPIC` is the *only* access control
  ntfy has, so it is **deliberately not in this public repo** — a Railway variable. Unset disables
  notifications rather than falling back to a guessable topic.
- **This repo is PUBLIC.** No secrets, no topic names, no tokens in the tree.

---

## 8. Where to look first

| Task | Start here |
|---|---|
| A patient's OOP estimate looks wrong | Not here — the Stedi backend computed it (§2). Check the row's `BNF_*` columns (flags, reasons, version) and the backend's `/oop/estimate` for that row; this repo only parses and shows it |
| The form shows a number the Monday column doesn't | §3 — the form asked the backend with the patient's *chosen* quantity (`source: "backend"`); the column holds the row's stored quantity. `/health` `stediBackend` says whether the backend is reachable |
| The form shows "Need benefits" or no card | §2: blank means unknown. `BNF_VERSION` blank = backend has not resolved the row; otherwise read `needsBenefits` / the OOP Est Note |
| A payer is $0 on one screen and charged on another | Both read the same backend columns now; if they differ, one of them is not reading (§2) |
| Something is still POSTing to `/webhooks/monday/oop-inputs` | Harmless — §3 "retired". `npm run check:oop-webhooks -- --delete` |
| Nobody got a text / everybody got a text | `backend/src/cron.js`, then `PRODUCTION_SMS_ENABLED` |
| A text says it sent but didn't arrive | the `reorder-sms-verify` queue in `backend/src/queue.js` |
| A status write silently did nothing | §3 — wrong label index, dropped at HTTP 200. `npm run check:labels` |
| A set is offered that Cardinal can't ship | `backend/src/skuStatus.js` and its name-collision rule |
| A patient can't open their link | `backend/src/auth.js`; token TTL is 20 days, JWT 24h |
| Form renders wrong / a control misbehaves | `docs/app.js` — vanilla JS, no build, no bundler |
