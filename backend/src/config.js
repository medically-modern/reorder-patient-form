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

  // Existing file columns
  CLINICALS_FILES:  "file_mkp0vm0a",                 // MN Docs / Clinicals files

  // Benefits / Stedi eligibility (used by OOP estimator)
  DEDUCTIBLE:             "text_mm3gbped",       // Text — total deductible (display only)
  DEDUCTIBLE_REMAINING:   "text_mm3g32ja",       // Text — deductible remaining (used in OOP math)
  STEDI_COINSURANCE:      "text_mm3gphed",       // Text — coinsurance % from Stedi (used in OOP math)
  OOP_MAX:                "text_mm3gh0q3",       // Text — total OOP max (display only)
  OOP_MAX_REMAINING:      "text_mm3gs345",       // Text — OOP max remaining (used in OOP math)

  // Portal notes
  PORTAL_NOTES:     "long_text_mm3evvzj",

  // Patient help message (from reorder form "Need a hand?" section)
  PATIENT_HELP_MSG: "long_text_mm3xnb6k",
};

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
  ORDER_RESPONSE_INDEX,
  INSURANCE_RESPONSE_INDEX,
  AUTH,
};
