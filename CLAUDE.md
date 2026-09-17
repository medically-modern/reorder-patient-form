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

## 2. ⚠️ `backend/src/oopEstimator.js` and `docs/oopEstimator.js` are BYTE-IDENTICAL MIRRORS

Apart from the trailing `module.exports = { estimateOop };` on the backend copy. The backend uses
it to write the estimate to Monday at link-creation time; the browser uses it to render the card
live. **Edit one, edit the other**, and diff them before committing.

**They are also two of four copies of the same payer policy across three repos**, and those copies
are checked against each other:

- **Canonical:** `medically-modern/command-center-test` → `src/lib/shared/payerPolicy.json`
  (rate schedule, zero-OOP payers, coinsurance overrides, the Medicaid / Medicare-style /
  Aetna-style sets).
- **The check:** that repo's `scripts/check-payer-policy.mjs` reads **these files** and fails when
  they disagree — on its CI, and on a weekday cron at 13:10 UTC.
- **The other copies:** command-center-test's `welcomeCall/oopEstimator.ts` and
  `profile/oopEstimate.ts`, and `coins-form-payment`'s `src/lib/oopEstimator.ts`.

So a payer changed here and not there turns another repo's CI red, and vice versa — which is the
point. A difference that is **deliberate** goes in that JSON under this consumer's `deviations`
with a reason; it is not left to be rediscovered.

⚠️ **The Python originals are checked by NOBODY.** `claim_assumptions.py` and `insurance_rules.py`
in `medicallymodern1/stedi-monday-integration` (a **different GitHub org**, FastAPI on Render) are
what every one of these headers cites as the source. Nothing can read them from this org. Sync by
hand and say so.

**Why this exists:** Aetna Medicare was made $0 here in Aug 2026 and never propagated; NYSHIP was
$0 in command-center and never propagated here. Both directions quoted real members real money for
fills their plan covers in full — one reached us as a patient email asking why her form said $105.

---

## 3. The board and the columns

**Subscription Board `18407459988`.** Every column ID is in `backend/src/config.js` — that file is
the contract, and IDs are what survive a rename on Monday. Notable ones:

- `DAYS_TO_ORDER` `color_mkxmtv9c` — the cron's trigger; it looks for the literal **"20 Days"**.
- `REORDER_TOKEN` / `REORDER_LINK` / `REORDER_TEXT_SENT` — the link and the send-once stamp.
- `OOP_ESTIMATE` `text_mm404p7d` — written once, at link creation. **A SNAPSHOT, not live.** The
  form recomputes in the browser, so this column can disagree with what the patient sees until the
  next link is generated. Backfill it by hand if a policy change matters retroactively.
- `PATIENT_ORDER_RESPONSE` `color_mm3kjykc` — Confirm=0 / Delay=1 / Cancel=2 (`ORDER_RESPONSE_INDEX`).

⚠️ **Status columns are written by INDEX, and Monday assigns those indexes itself** — it takes the
lowest free slot when a label is created, not display order. A write to an index the column does
not have is accepted at **HTTP 200 and dropped**, with nothing in the logs. `getStatusIndexMap()`
in `monday.js` reads them from the live board for this reason; `backend/src/checkLabels.js`
(`npm run check:labels`) audits them. **Never infer an index.**

⚠️ **Patients are routed by Monday `itemId`, NOT by UID** (commit `f47556c`). UID is display only.

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
`reorder-confirmation-sms`, `reorder-sms-verify`. The last one re-reads RingCentral ~10 minutes
later to confirm messages actually went out — **an accepted SMS is not a delivered SMS**.

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
- **PHI is everywhere.** Patient data is on every board and in every payload. Don't put it in
  logs, commits or artifacts.
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
| A patient's OOP estimate looks wrong | `backend/src/oopEstimator.js` (+ its `docs/` mirror) — and §2: the canonical list is in another repo |
| A payer is $0 on one screen and charged on another | §2. Run command-center-test's `node scripts/check-payer-policy.mjs` |
| The Monday `OOP Estimate` column disagrees with the form | §3 — the column is a link-creation snapshot, the form is live |
| Nobody got a text / everybody got a text | `backend/src/cron.js`, then `PRODUCTION_SMS_ENABLED` |
| A text says it sent but didn't arrive | the `reorder-sms-verify` queue in `backend/src/queue.js` |
| A status write silently did nothing | §3 — wrong label index, dropped at HTTP 200. `npm run check:labels` |
| A set is offered that Cardinal can't ship | `backend/src/skuStatus.js` and its name-collision rule |
| A patient can't open their link | `backend/src/auth.js`; token TTL is 20 days, JWT 24h |
| Form renders wrong / a control misbehaves | `docs/app.js` — vanilla JS, no build, no bundler |
