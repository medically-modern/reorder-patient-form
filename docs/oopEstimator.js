/**
 * oopEstimator.js — Out-of-Pocket Estimator (vanilla JS port)
 *
 * Exact port of command-center/src/lib/welcomeCall/oopEstimator.ts
 *
 * Mirrors the backend's claim_assumptions.py PAYER_RATE_SCHEDULE and
 * financial_estimate_service.py math, then layers deductible + coinsurance
 * + OOP max math on top.
 *
 * All rates are per-unit. Units-per-fill come from the backend's standard
 * assumptions (3 sensor units, sets×10 for commercial supplies, fixed 13+30
 * for Medicare-style supplies, 1 pump, 1 monitor).
 *
 * Coinsurance overrides (insurance_rules.py) are applied here so
 * Humana = 0% just works. Medicare/United Medicare use real Stedi coinsurance
 * unless secondary is Medicaid (then $0 OOP).
 */

// ─── Rate Schedule (source: claim_assumptions.py PAYER_RATE_SCHEDULE) ────────

const PAYER_RATE_SCHEDULE = {
  "NYSHIP": { pump_rate: 4326.7, infusion_rate: 24.64, cartridge_rate: 3.30, monitor_rate: 298.7, sensor_rate: 315.26 },
  "Anthem BCBS Commercial": { pump_rate: 4200.0, infusion_rate: 8.75, cartridge_rate: 2.95, monitor_rate: 400.0, sensor_rate: 375.0 },
  "Anthem BCBS Medicare": { pump_rate: 4200.0, infusion_rate: 25.19, cartridge_rate: 3.38, monitor_rate: 267.92, sensor_rate: 255.0 },
  "Anthem BCBS Medicaid (JLJ)": { pump_rate: 4200.0, infusion_rate: 8.75, cartridge_rate: 2.95, monitor_rate: null, sensor_rate: null },
  "Anthem BCBS Low-Cost (JLJ)": { pump_rate: 4200.0, infusion_rate: 8.75, cartridge_rate: 2.95, monitor_rate: null, sensor_rate: null },
  "Fidelis Commercial": { pump_rate: 4000, infusion_rate: 11.17, cartridge_rate: 2.65, monitor_rate: 193.97, sensor_rate: 218.09 },
  "Fidelis Medicaid": { pump_rate: 4000, infusion_rate: 15.2, cartridge_rate: 3.61, monitor_rate: null, sensor_rate: null },
  "Fidelis Medicare": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: 218.13 },
  "Fidelis Low-Cost": { pump_rate: 4000, infusion_rate: 11.17, cartridge_rate: 2.65, monitor_rate: 193.97, sensor_rate: 218.09 },
  "Medicare A&B": { pump_rate: 600.0, infusion_rate: 29.07, cartridge_rate: 3.62, monitor_rate: 322.63, sensor_rate: 318.00 },
  "Medicaid": { pump_rate: 4440.0, infusion_rate: 15.2, cartridge_rate: 3.61, monitor_rate: null, sensor_rate: null },
  "United Commercial": { pump_rate: null, infusion_rate: 6.97, cartridge_rate: 1.83, monitor_rate: 167.27, sensor_rate: 176.55 },
  "United Medicare": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: 167.27, sensor_rate: 176.55 },
  "Aetna Commercial": { pump_rate: 1597.0, infusion_rate: 23.51, cartridge_rate: 0.92, monitor_rate: 191.17, sensor_rate: 173.41 },
  "Aetna Medicare": { pump_rate: 1597.0, infusion_rate: 23.51, cartridge_rate: 0.92, monitor_rate: 191.17, sensor_rate: 201.77 },
  "Wellcare": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: 241.97, sensor_rate: 229.13 },
  "Humana": { pump_rate: 5431.0, infusion_rate: 16.37, cartridge_rate: 2.20, monitor_rate: 295.36, sensor_rate: 317.97 },
  "Cigna": { pump_rate: 4200.0, infusion_rate: 17.75, cartridge_rate: 2.36, monitor_rate: 214.05, sensor_rate: 170.42 },
  "Midlands Choice": { pump_rate: 5644.0, infusion_rate: 31.68, cartridge_rate: 3.96, monitor_rate: 331.40, sensor_rate: 349.77 },
  "Horizon BCBS": { pump_rate: 4300.0, infusion_rate: 10.90, cartridge_rate: 3.10, monitor_rate: 480.0, sensor_rate: 445.0 },
  "BCBS TN": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
  "BCBS FL": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
  "BCBS WY": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
  "United Medicaid": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
  "United Low-Cost": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
  "MagnaCare": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
  "UMR": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
  "Oregon Care": { pump_rate: null, infusion_rate: null, cartridge_rate: null, monitor_rate: null, sensor_rate: null },
};

// ─── Supply HCPC groups (determines unit calculation) ────────────────────────

const MEDICARE_STYLE_INFUSION_PAYERS = new Set([
  "Anthem BCBS Medicare", "Fidelis Medicare", "Medicare A&B", "NYSHIP",
  "United Medicare", "Wellcare", "Humana", "Cigna", "Midlands Choice",
]);

// Aetna uses Group C codes (A4231/A4232) — same units as commercial (sets×10)
// but different infusion HCPC than Group A (A4230). Matches backend SUPPLY_HCPC_MAP.
const AETNA_STYLE_PAYERS = new Set([
  "Aetna Commercial", "Aetna Medicare",
]);

// Medicaid supplies split — these payers bill supplies under "Medicaid" rates
const SUPPLIES_ROUTE_TO_MEDICAID = new Set([
  "Fidelis Medicaid", "Anthem BCBS Medicaid (JLJ)", "Medicaid",
]);

// ─── Secondary Medicaid detection ────────────────────────────────────────────

function isSecondaryMedicaid(secondary) {
  if (!secondary) return false;
  const s = secondary.toLowerCase();
  return s.includes("medicaid");
}

// ─── Primary Medicaid detection ──────────────────────────────────────────────

const PRIMARY_MEDICAID_LABELS = new Set([
  "Fidelis Medicaid",
  "Anthem BCBS Medicaid (JLJ)",
  "Anthem BCBS Low-Cost (JLJ)",
  "Wellcare",
  "Medicaid",
  "United Medicaid",
]);

// Medicare A&B: patient always pays $0 OOP (MM bills Medicare directly)
const ZERO_OOP_PAYERS = new Set([
  "Medicare A&B",
]);

// ─── Coinsurance overrides (source: insurance_rules.py) ──────────────────────
// NOTE: Removed Medicare A&B and United Medicare from blanket 0% override.
// Those were a shortcut assuming dual-eligible (Medicaid secondary). Now we
// check secondary explicitly. If no Medicaid secondary, Medicare patients
// use real Stedi coinsurance (typically 20% for Part B DME).

const COINSURANCE_OVERRIDES = {
  // Humana removed — now handled per-product (0% CGM, Stedi% pump/supplies)
};

// ─── Humana split coinsurance ───────────────────────────────────────────────
// CGM products (monitor + sensors) = 0% coinsurance
// Pump and supply products = real Stedi coinsurance
const HUMANA_CGM_PRODUCTS = new Set(["CGM Sensors"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}

function parseNumber(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,%\s]/g, "").replace(/,/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Resolve coinsurance %, applying overrides from insurance_rules.py.
 * Returns a whole-number percentage (e.g. 20 for 20%).
 */
function resolveCoinsurance(primaryInsurance, stediRaw) {
  const override = COINSURANCE_OVERRIDES[primaryInsurance];
  if (override !== undefined) return override;

  const val = parseNumber(stediRaw);
  if (val === null) return 0;
  // Stedi sometimes returns decimal (0.2) vs percentage (20)
  return val < 1 ? val * 100 : val;
}

/**
 * Determine which products are in scope based on the "serving" field.
 * Returns { hasCgm, hasPump, hasSupplies }.
 */
function servingToProducts(serving) {
  const s = (serving || "").toLowerCase();
  // Serving values: "CGM", "Pump & Supplies", "CGM & Pump & Supplies", "Supplies", etc.
  const hasCgm = s.includes("cgm");
  const hasPump = s.includes("pump");
  const hasSupplies = s.includes("suppli") || s.includes("pump"); // pump always includes supplies
  return { hasCgm, hasPump, hasSupplies };
}

// ─── Label aliases (source: financial_estimate_service.py) ───────────────────

const PRIMARY_INSURANCE_ALIASES = {
  "Magnacare": "MagnaCare",
  "BCBS Wyoming": "BCBS WY",
};

function canonicalize(label) {
  const trimmed = (label || "").trim();
  return PRIMARY_INSURANCE_ALIASES[trimmed] || trimmed;
}

// ─── Main estimator ──────────────────────────────────────────────────────────

/**
 * Estimate out-of-pocket costs for a patient's fill.
 *
 * @param {Object} inputs
 * @param {string} inputs.primaryInsurance
 * @param {string} inputs.secondaryInsurance
 * @param {string} inputs.serving — determines which products
 * @param {number} [inputs.infusionSets=3] — number of infusion sets
 * @param {string} inputs.deductibleRemaining — raw string from Monday
 * @param {string} inputs.stediCoinsurance — raw coinsurance % string
 * @param {string} inputs.oopMaxRemaining — raw OOP max remaining string
 * @returns {Object} OopEstimate or OopEstimateError
 */
function estimateOop(inputs) {
  const serving = inputs.serving;
  const infusionSets = inputs.infusionSets || 3;
  const primaryInsurance = canonicalize(inputs.primaryInsurance);

  if (!primaryInsurance) {
    return { ok: false, reason: "Missing primary insurance" };
  }

  const rates = PAYER_RATE_SCHEDULE[primaryInsurance];
  if (!rates) {
    return { ok: false, reason: 'No rate schedule for "' + primaryInsurance + '"' };
  }

  const { hasCgm, hasPump, hasSupplies } = servingToProducts(serving);
  if (!hasCgm && !hasPump && !hasSupplies) {
    return { ok: false, reason: 'Cannot determine products from serving: "' + serving + '"' };
  }

  // Build line items
  const lines = [];

  // --- CGM: Sensors only (3 units A4239) ---
  // Monitor (E2103) and Pump (E0784) excluded — this is a reorder form,
  // patients already have the hardware. Only consumables are estimated.
  if (hasCgm) {
    if (rates.sensor_rate !== null) {
      lines.push({
        product: "CGM Sensors",
        hcpc: "A4239",
        units: 3,
        rate: rates.sensor_rate,
        allowed: round2(3 * rates.sensor_rate),
      });
    }
  }

  // --- Supplies: infusion sets + cartridges ---
  if (hasSupplies) {
    // Apply Medicaid supplies split
    const suppliesPayer = SUPPLIES_ROUTE_TO_MEDICAID.has(primaryInsurance)
      ? "Medicaid"
      : primaryInsurance;
    const suppliesRates = PAYER_RATE_SCHEDULE[suppliesPayer];

    if (suppliesRates) {
      const isMedicareStyle = MEDICARE_STYLE_INFUSION_PAYERS.has(suppliesPayer);
      const isAetnaStyle = AETNA_STYLE_PAYERS.has(suppliesPayer);
      const infusionUnits = isMedicareStyle ? 13 : infusionSets * 10;
      const cartridgeUnits = isMedicareStyle ? 30 : infusionSets * 10;
      // Group B: A4224/A4225 (Medicare), Group C: A4231/A4232 (Aetna), Group A: A4230/A4232 (commercial)
      const infusionCode = isMedicareStyle ? "A4224" : isAetnaStyle ? "A4231" : "A4230";
      const cartridgeCode = isMedicareStyle ? "A4225" : "A4232";

      if (suppliesRates.infusion_rate !== null) {
        lines.push({
          product: "Infusion Sets",
          hcpc: infusionCode,
          units: infusionUnits,
          rate: suppliesRates.infusion_rate,
          allowed: round2(infusionUnits * suppliesRates.infusion_rate),
        });
      }
      if (suppliesRates.cartridge_rate !== null) {
        lines.push({
          product: "Cartridges",
          hcpc: cartridgeCode,
          units: cartridgeUnits,
          rate: suppliesRates.cartridge_rate,
          allowed: round2(cartridgeUnits * suppliesRates.cartridge_rate),
        });
      }
    }
  }

  if (lines.length === 0) {
    return { ok: false, reason: 'No rates available for "' + primaryInsurance + '" with serving "' + serving + '"' };
  }

  const totalAllowed = round2(lines.reduce(function (sum, l) { return sum + l.allowed; }, 0));

  // --- Medicaid check: primary Medicaid plan OR secondary Medicaid → $0 OOP ---
  const isPrimaryMedicaid = PRIMARY_MEDICAID_LABELS.has(primaryInsurance);
  const hasSecondaryMedicaid = isSecondaryMedicaid(inputs.secondaryInsurance);

  if (isPrimaryMedicaid || hasSecondaryMedicaid) {
    const note = isPrimaryMedicaid
      ? primaryInsurance + " is a Medicaid plan — no patient cost share"
      : "Secondary " + inputs.secondaryInsurance + " covers remaining balance";
    return {
      ok: true,
      lines: lines,
      totalAllowed: totalAllowed,
      appliedDeductible: 0,
      postDeductible: totalAllowed,
      coinsurancePct: 0,
      patientCoinsurance: 0,
      patientOwesRaw: 0,
      oopMaxRemaining: null,
      patientOwes: 0,
      insurancePays: totalAllowed,
      medicaidCovers: true,
      medicaidNote: note,
      canCalculateCosts: true,
      missingFields: [],
    };
  }

  // Medicare A&B (and other zero-OOP payers): patient always pays $0
  if (ZERO_OOP_PAYERS.has(primaryInsurance)) {
    return {
      ok: true,
      lines: lines,
      totalAllowed: totalAllowed,
      appliedDeductible: 0,
      postDeductible: totalAllowed,
      coinsurancePct: 0,
      patientCoinsurance: 0,
      patientOwesRaw: 0,
      oopMaxRemaining: null,
      patientOwes: 0,
      insurancePays: totalAllowed,
      medicaidCovers: true,
      medicaidNote: primaryInsurance + " — no patient cost share",
      canCalculateCosts: true,
      missingFields: [],
    };
  }

  // --- OOP Math (non-Medicaid) ---
  const hasCoinsuranceOverride = COINSURANCE_OVERRIDES[primaryInsurance] !== undefined;
  const parsedDeductible = parseNumber(inputs.deductibleRemaining);
  const parsedCoinsurance = parseNumber(inputs.stediCoinsurance);
  const oopMaxRaw = parseNumber(inputs.oopMaxRemaining);

  // Humana CGM-only: coinsurance is known (0%) even without Stedi data.
  const isHumanaCgmOnly = primaryInsurance === "Humana" &&
    lines.every(function (l) { return HUMANA_CGM_PRODUCTS.has(l.product); });

  // Track which specific fields are missing for granular UI warnings
  const missingFields = [];
  if (parsedDeductible === null) missingFields.push("deductible");
  if (parsedCoinsurance === null && !hasCoinsuranceOverride && !isHumanaCgmOnly) missingFields.push("coinsurance");
  if (oopMaxRaw === null) missingFields.push("oopMax");

  // Can we compute patient costs? Need BOTH deductible AND coinsurance.
  const hasDeductible = parsedDeductible !== null;
  const hasCoinsurance = parsedCoinsurance !== null || hasCoinsuranceOverride || isHumanaCgmOnly;
  const canCalculateCosts = hasDeductible && hasCoinsurance;

  const oopMaxRemaining = oopMaxRaw !== null ? oopMaxRaw : null;

  if (!canCalculateCosts) {
    return {
      ok: true,
      lines: lines,
      totalAllowed: totalAllowed,
      appliedDeductible: null,
      postDeductible: null,
      coinsurancePct: hasCoinsurance ? resolveCoinsurance(primaryInsurance, inputs.stediCoinsurance) : null,
      patientCoinsurance: null,
      patientOwesRaw: null,
      oopMaxRemaining: oopMaxRemaining,
      patientOwes: null,
      insurancePays: null,
      medicaidCovers: false,
      medicaidNote: "",
      canCalculateCosts: false,
      missingFields: missingFields,
    };
  }

  // Both deductible and coinsurance are known — safe to compute
  const deductibleRemaining = parsedDeductible;
  const coinsurancePct = resolveCoinsurance(primaryInsurance, inputs.stediCoinsurance);

  const appliedDeductible = round2(Math.min(totalAllowed, Math.max(0, deductibleRemaining)));
  const postDeductible = round2(totalAllowed - appliedDeductible);

  // ─── Humana split coinsurance ─────────────────────────────────────────
  var patientCoinsurance;
  if (primaryInsurance === "Humana") {
    const cgmAllowed = lines
      .filter(function (l) { return HUMANA_CGM_PRODUCTS.has(l.product); })
      .reduce(function (sum, l) { return sum + l.allowed; }, 0);
    const nonCgmAllowed = totalAllowed - cgmAllowed;

    const cgmProportion = totalAllowed > 0 ? cgmAllowed / totalAllowed : 0;
    const cgmDed = round2(appliedDeductible * cgmProportion);
    const nonCgmDed = round2(appliedDeductible - cgmDed);

    const cgmPostDed = round2(cgmAllowed - cgmDed);
    const nonCgmPostDed = round2(nonCgmAllowed - nonCgmDed);

    const cgmCoins = 0;
    const nonCgmCoins = round2(nonCgmPostDed * (coinsurancePct / 100));
    patientCoinsurance = round2(cgmCoins + nonCgmCoins);
  } else {
    patientCoinsurance = round2(postDeductible * (coinsurancePct / 100));
  }

  const patientOwesRaw = round2(appliedDeductible + patientCoinsurance);
  const patientOwes = oopMaxRemaining !== null
    ? round2(Math.min(patientOwesRaw, Math.max(0, oopMaxRemaining)))
    : patientOwesRaw;
  const insurancePays = round2(totalAllowed - patientOwes);

  return {
    ok: true,
    lines: lines,
    totalAllowed: totalAllowed,
    appliedDeductible: appliedDeductible,
    postDeductible: postDeductible,
    coinsurancePct: coinsurancePct,
    patientCoinsurance: patientCoinsurance,
    oopMaxRemaining: oopMaxRemaining,
    patientOwesRaw: patientOwesRaw,
    patientOwes: patientOwes,
    insurancePays: insurancePays,
    medicaidCovers: false,
    medicaidNote: "",
    canCalculateCosts: true,
    missingFields: missingFields,
  };
}
