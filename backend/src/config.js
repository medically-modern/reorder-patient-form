// ─── Board & Column Configuration ───
// Maps Monday.com Subscription Board columns to reorder data model

const SUBSCRIPTION_BOARD_ID = "18407459988";

// Column IDs — Subscription Board
const COLUMNS = {
  // Core subscription
  STATUS:           "color_mm2t7tdy",     // Active / Paused / Dead
  DAYS_TO_ORDER:    "color_mkxmtv9c",     // 10 Days, 20 Days, etc.
  ORDERING_CYCLE:   "color_mkyjawhq",     // Benefits, Order, Next Order Awaiting, Confirm Order
  NEXT_ORDER:       "date_mkp0nvf1",      // Next order date
  SUBSCRIPTION:     "color_mm273mv8",     // Sensors / Supplies / Sensors & Supplies
  ORDER_TYPE:       "color_mm2w6kd",      // First Order / Reorder
  PATIENT_UID:      "text_mm3af3zt",      // Patient UID

  // Insurance activity
  ACTIVE_STATUS:    "color_mm2nzm33",     // Active / Inactive / Medicare Advantage

  // Demographics
  DOB:              "text_mkvdefh1",
  GENDER:           "color_mm1zgyy2",
  PHONE:            "phone_mkp0q3cw",
  EMAIL:            "email_mkp01rrw",
  ADDRESS:          "location_mkp0rs0v",

  // Insurance
  PRIMARY_INS:      "color_mm254qxj",
  MEMBER_ID_1:      "text_mkvp6zfg",
  SECONDARY_INS:    "color_mm25cr82",
  MEMBER_ID_2:      "text_mm25cpx6",

  // Medical necessity
  CGM_COVERAGE:     "color_mm2cmgqe",
  MN_EXPIRY:        "date_mkp09gra",

  // Sensors auth
  SENSORS_AUTH:     "color_mm25t997",
  SENSORS_UNITS:    "numeric_mkwbzsg2",
  SENSORS_START:    "date_mkwb4q5e",
  SENSORS_END:      "date_mkwbvr6t",

  // Supplies auth
  SUPPLIES_AUTH:    "color_mm27snkq",
  SUPPLIES_UNITS:   "numeric_mm25mf8k",
  SUPPLIES_START:   "date_mm25csyr",
  SUPPLIES_END:     "date_mm255cs4",

  // Order details
  SENSORS_TYPE:     "color_mkxmdscr",     // FreeStyle Libre 3 Plus, Dexcom G7, etc.
  CGM_QTY:          "numeric_mm3sr332",   // CGM sensor boxes (default 3, 0 = skipped)
  SUPPLIES_TYPE:    "color_mkxmnheg",     // t:slim, Omnipod, Mobi, etc.
  CARTRIDGE_QTY:    "numeric_mm3sfe56",   // Cartridge boxes (default 3, 0 = skipped)
  INFUSION_SET_1:   "color_mkxm50f9",
  INF_QTY_1:        "numeric_mkw839ks",
  INFUSION_SET_2:   "color_mkxmx5wk",
  INF_QTY_2:        "numeric_mkwac234",

  // ─── REORDER-SPECIFIC COLUMNS (new) ───
  PATIENT_ORDER_RESPONSE:     "color_mm3kjykc",     // Confirm=0 / Delay=1 / Cancel=2
  PATIENT_RESPONSE_TIMESTAMP: "text_mm3kt9bs",      // ISO timestamp string
  PATIENT_CHANGE_SUMMARY:     "long_text_mm3k5y3n", // Long text — auto-generated change summary
  PATIENT_INSURANCE_RESPONSE: "color_mm3k4z79",     // Confirmed=0 / Changed=1
  NEW_INSURANCE_TYPE:         "text_mm3k52t6",       // Text — new insurance name
  NEW_MEMBER_ID:              "text_mm3kvsx6",       // Text — new member ID
  REORDER_TOKEN:              "text_mm3kvqxx",       // Text — reorder confirmation token
  REORDER_LINK:               "text_mm3khve4",       // Text — reorder confirmation link
  INSURANCE_CARD:             "file_mm3knk5q",       // File — uploaded insurance card images
  REORDER_TEXT_SENT:          "text_mm3rzqks",       // Text — timestamp when reorder SMS was sent (cron dedup)
  OOP_ESTIMATE:               "text_mm404p7d",       // Text — "OOP Estimate" = Recurring OOP (consumables, deductible treated as met).
                                                     //   WRITTEN BY THE STEDI BACKEND, READ-ONLY HERE. This repo must never write it.

  // Existing file columns
  CLINICALS_FILES:  "file_mkp0vm0a",                 // MN Docs / Clinicals files

  // Legacy Stedi eligibility columns — the payer's raw format, display only. No math
  // in this repo reads them any more (the Stedi backend resolves benefits itself).
  DEDUCTIBLE:             "text_mm3gbped",       // Text — total deductible
  DEDUCTIBLE_REMAINING:   "text_mm3g32ja",       // Text — deductible remaining
  STEDI_COINSURANCE:      "text_mm3gphed",       // Text — coinsurance % from Stedi
  OOP_MAX:                "text_mm3gh0q3",       // Text — total OOP max
  OOP_MAX_REMAINING:      "text_mm3gs345",       // Text — OOP max remaining

  // ─── Benefits snapshot — WRITTEN BY THE STEDI BACKEND (stedi-monday-integration) ───
  // READ-ONLY here. Ids and value formats are the reader contract (CLAUDE.md §2); the
  // same ids exist on Profile Send Off, except that this board's recurring estimate is
  // the existing OOP_ESTIMATE column above. Blank = unknown — NEVER treat blank as 0.
  BNF_COINS_CGM:    "text_bnf_coins_cgm",   // "15" = 15%, "15-35" = unresolved range, "" = unknown
  BNF_COINS_DME:    "text_bnf_coins_dme",   // same (pump + supplies)
  BNF_COPAY_CGM:    "text_bnf_copay_cgm",   // "10" = $10, "0-1000" = range, "" = none/unknown
  BNF_COPAY_DME:    "text_bnf_copay_dme",   // same
  BNF_CANDIDATES:   "text_bnf_candidates",  // audit text, display only
  BNF_DED_USED:     "text_bnf_ded_used",    // dollars, "" = unknown
  BNF_DED_LEVEL:    "text_bnf_ded_level",   // "IND" / "FAM (family_fallback)" / "IND (inferred_zero)" / "IND (derived)"
  BNF_OOP_USED:     "text_bnf_oop_used",    // dollars, "" = unknown
  BNF_OOP_LEVEL:    "text_bnf_oop_level",   // "IND" / "FAM" / ""
  BNF_CONFIDENCE:   "color_bnf_confidence", // status — High / Medium / Low (the whole resolution's)
  BNF_OOP_CONF:     "text_bnf_oop_conf",    // text — High / Medium / Low: the ESTIMATE's own, serving-aware; show this beside the figure (blank -> BNF_CONFIDENCE)
  BNF_FLAGS:        "dropdown_bnf_flags",   // dropdown — zero or more flag codes (benefitsFlags.json has the text)
  BNF_REASONS:      "text_bnf_reasons",     // one decision per line, display only
  BNF_VERSION:      "text_bnf_version",     // e.g. "br-2026.10.07.2"; BLANK = backend has not resolved this item yet
  BNF_FIRST_WMON:   "text_bnf_first_wmon",  // OOP Est First Order (incl. monitor) — "$228.75" / "$228.75-$533.75" / "$0" / "Need benefits" / ""
  BNF_OOP_NOTE:     "text_bnf_oop_note",    // why ($0 reason, what is missing)
  BNF_OOP_LINES:    "text_bnf_oop_lines",   // per-line audit, " || "-joined

  // Portal notes
  PORTAL_NOTES:     "long_text_mm3evvzj",

  // Patient help message (from reorder form "Need a hand?" section)
  PATIENT_HELP_MSG: "long_text_mm3xnb6k",
};

// ─── Retired OOP webhook columns ───
// Until 2026-10 this repo recomputed OOP_ESTIMATE itself whenever one of these columns
// changed, via a Monday webhook per column → POST /webhooks/monday/oop-inputs. The
// Stedi backend now owns that column, so the webhooks are retired: the route only
// acknowledges them and `npm run check:oop-webhooks` lists any still on the board so
// they can be deleted. This list exists only for that cleanup.
const RETIRED_OOP_WEBHOOK_COLUMNS = [
  COLUMNS.PRIMARY_INS,
  COLUMNS.SECONDARY_INS,
  COLUMNS.SENSORS_TYPE,
  COLUMNS.SUPPLIES_TYPE,
  COLUMNS.INFUSION_SET_1,
  COLUMNS.INF_QTY_1,
  COLUMNS.INF_QTY_2,
  COLUMNS.DEDUCTIBLE_REMAINING,
  COLUMNS.STEDI_COINSURANCE,
  COLUMNS.OOP_MAX_REMAINING,
];

// ─── Stedi backend (owns the OOP math) ───
// Read at call time, not at load, so tests can set the env and a missing variable
// surfaces as a clean "not configured" rather than a half-built URL. Both are Railway
// variables — this repo is public.
const STEDI_BACKEND_TIMEOUT_MS = 6000;

function stediBackendConfig() {
  return {
    url: (process.env.STEDI_BACKEND_URL || "").trim().replace(/\/+$/, ""),
    adminKey: (process.env.STEDI_ADMIN_KEY || "").trim(),
    timeoutMs: STEDI_BACKEND_TIMEOUT_MS,
  };
}

// Status index maps for reorder-specific columns
const ORDER_RESPONSE_INDEX = {
  CONFIRM: 0,
  DELAY:   1,
  CANCEL:  2,
};

const INSURANCE_RESPONSE_INDEX = {
  CONFIRMED: 0,
  CHANGED:   1,
};

// Auth configuration
const AUTH = {
  TOKEN_BYTES: 32,                    // 32 bytes = 64 hex chars
  TOKEN_TTL: 86400 * 20,             // 20 days for reorder token (matches reorder cycle window)
  JWT_EXPIRY: "24h",                  // 24-hour session (shorter than portal — single form fill)
  RATE_LIMIT_AUTH: 50,                // Per-token verification attempts
  RATE_LIMIT_AUTH_WINDOW: 3600,       // 1 hour
};

module.exports = {
  SUBSCRIPTION_BOARD_ID,
  COLUMNS,
  RETIRED_OOP_WEBHOOK_COLUMNS,
  STEDI_BACKEND_TIMEOUT_MS,
  stediBackendConfig,
  ORDER_RESPONSE_INDEX,
  INSURANCE_RESPONSE_INDEX,
  AUTH,
};
