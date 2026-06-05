// ═══════════════════════════════════════════════════════
// Medically Modern — Reorder Confirmation
// Single-page card-based UI (v2)
// ALL LOGIC PRESERVED from wizard version
// ═══════════════════════════════════════════════════════

const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:3001"
  : "https://reorder-patient-form-production.up.railway.app";

// ─── State ───
const state = {
  patientData: null,
  orderOptions: null,
  sessionToken: null,

  // Date
  originalDate: null,     // original order date (for delay detection)
  delayDate: null,
  delayLessThan20Days: false,

  // Items
  infQty1: 3,
  infQty2: 0,
  cartridgeQty: 3,
  hasSecondSet: false,

  // Snapshots of initial state (for change detection)
  initialSensorType: null,
  initialInfLabel1: null,
  initialInfIndex1: null,
  initialInfQty1: 0,
  initialInfLabel2: null,
  initialInfIndex2: null,
  initialInfQty2: 0,

  // Address
  addressChanged: false,
  newAddress: null,
  addressSelectedFromGoogle: false,
  addressCoords: { lat: 0, lng: 0 },

  // Insurance
  insuranceChanged: false,
  uploadedFiles: [],

  // Help
  helpChip: null,
  helpMessage: "",
};

// ─── Init ───
document.addEventListener("DOMContentLoaded", init);

async function init() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");

  if (!token) {
    showError("No reorder link found. Please use the link from your text message.");
    return;
  }

  try {
    const authRes = await apiFetch(`/auth/verify/${token}`, { method: "GET" });
    if (authRes.alreadySubmitted) {
      showSuccess(authRes.message, { hideSubtext: true });
      return;
    }
    if (!authRes.success) {
      showError(authRes.error || "Invalid or expired link.");
      return;
    }
    state.sessionToken = authRes.token;

    const [meRes, optionsRes, configRes] = await Promise.all([
      apiFetch("/api/me"),
      apiFetch("/api/order-options"),
      apiFetch("/api/config"),
    ]);

    state.patientData = meRes;
    state.orderOptions = optionsRes;

    if (configRes.googleMapsKey) {
      loadGooglePlaces(configRes.googleMapsKey);
    }

    renderPage();
  } catch (err) {
    console.error("Init error:", err);
    showError("Something went wrong loading your information. Please try your link again.");
  }
}

// ─── API helper ───
async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.sessionToken) headers["Authorization"] = `Bearer ${state.sessionToken}`;
  const res = await fetch(`${API_BASE}${path}`, { credentials: "include", headers, ...opts });
  const data = await res.json();
  if (!res.ok && !data.error) throw new Error(`API error: ${res.status}`);
  return data;
}

// ═══════════════════════════════════════════════════════
// RENDER — populate the page from patient data
// ═══════════════════════════════════════════════════════

function renderPage() {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("app").style.display = "block";

  const pd = state.patientData;

  // Greeting
  if (pd.name) {
    const firstName = pd.name.split(" ")[0];
    document.getElementById("patient-greeting").textContent = `Hey ${firstName} — here's your refill.`;
  }

  // ─── Date card ───
  const nextOrder = pd.nextOrder;
  state.originalDate = nextOrder;
  if (nextOrder) {
    const d = new Date(nextOrder + "T00:00:00");
    const dateStr = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const dayStr = d.toLocaleDateString("en-US", { weekday: "long" });
    document.getElementById("order-date-display").textContent = `${dateStr} · ${dayStr}`;

    // Postpone buttons use the original date as the base — stored in state.originalDate
  } else {
    document.getElementById("order-date-display").textContent = "Not scheduled";
  }

  // ─── Product rows ───
  renderProductRows();

  // ─── Order edit panel ───
  renderOrderEditPanel();

  // ─── Address card ───
  const addr = pd.address || "No address on file";
  const firstComma = addr.indexOf(",");
  if (firstComma > 0) {
    document.getElementById("address-line1").textContent = addr.slice(0, firstComma).trim();
    document.getElementById("address-line2").textContent = addr.slice(firstComma + 1).trim();
  } else {
    document.getElementById("address-line1").textContent = addr;
    document.getElementById("address-line2").textContent = "";
  }
  checkApartmentWarning(addr);

  // ─── Insurance card ───
  document.getElementById("ins-type-display").textContent = simplifyInsurance(pd.primaryInsurance || "Unknown");
  document.getElementById("ins-member-display").innerHTML = "Member ID: " + maskMemberId(pd.memberId1 || "");

  // ─── OOP ───
  updateOop();
}

// ─── Product rows (display) ───
function renderProductRows() {
  const pd = state.patientData;

  // Sensors
  if (pd.servingSensors) {
    const row = document.getElementById("prod-sensors");
    row.style.display = "";
    document.getElementById("prod-sensors-name").textContent = pd.sensorsType || "CGM Sensor";
    document.getElementById("prod-sensors-qty").textContent = "90-day";
    document.getElementById("prod-sensors-unit").textContent = "supply";
  }

  // Infusion Set 1
  if (pd.servingInfusionSet1) {
    const row = document.getElementById("prod-inf1");
    row.style.display = "";
    document.getElementById("prod-inf1-name").textContent = pd.infusionSet1 || "Infusion Set";
    const raw1 = parseInt(pd.infQty1, 10);
    const qty1 = isNaN(raw1) ? 3 : raw1;
    state.infQty1 = qty1;
    document.getElementById("prod-inf1-qty").textContent = String(qty1);
    document.getElementById("prod-inf1-unit").textContent = qty1 === 1 ? "box" : "boxes";
  }

  // Infusion Set 2
  if (pd.servingInfusionSet2) {
    const row = document.getElementById("prod-inf2");
    row.style.display = "";
    state.hasSecondSet = true;
    document.getElementById("prod-inf2-name").textContent = pd.infusionSet2 || "Infusion Set 2";
    const raw2 = parseInt(pd.infQty2, 10);
    const qty2 = isNaN(raw2) ? 0 : raw2;
    state.infQty2 = qty2;
    if (qty2 === 0) {
      document.getElementById("prod-inf2-qty").textContent = "0";
      document.getElementById("prod-inf2-unit").textContent = "SKIPPED";
      row.classList.add("skipped");
    } else {
      document.getElementById("prod-inf2-qty").textContent = String(qty2);
      document.getElementById("prod-inf2-unit").textContent = qty2 === 1 ? "box" : "boxes";
    }
  }

  // Cartridges
  if (pd.servingSupplies) {
    const row = document.getElementById("prod-cartridges");
    row.style.display = "";
    document.getElementById("prod-cartridges-name").textContent = (pd.suppliesType || "Pump") + " cartridge";
    const rawCart = parseInt(pd.cartridgeQty, 10);
    const cartQty = isNaN(rawCart) ? 3 : Math.max(rawCart, 1);
    state.cartridgeQty = cartQty;
    document.getElementById("prod-cartridges-qty").textContent = String(cartQty);
    document.getElementById("prod-cartridges-unit").textContent = cartQty === 1 ? "box" : "boxes";
  }
}

// ─── Order edit panel (dropdowns/steppers) ───
function renderOrderEditPanel() {
  const pd = state.patientData;
  const opts = state.orderOptions;

  // Sensors
  if (pd.servingSensors && opts?.sensorsTypes?.length > 0) {
    document.getElementById("edit-sensors").style.display = "";
    const select = document.getElementById("sensor-type-select");
    select.innerHTML = opts.sensorsTypes
      .map(o => `<option value="${escAttr(o.label)}" ${o.label.toLowerCase() === (pd.sensorsType || "").toLowerCase() ? "selected" : ""}>${escHtml(o.label)}</option>`)
      .join("");
  }

  // Infusion
  if (pd.servingInfusionSet1) {
    document.getElementById("edit-infusion").style.display = "";
    populateInfusionDropdowns(1, pd.infusionSet1);
    document.getElementById("inf-qty-1").textContent = String(state.infQty1);

    if (pd.servingInfusionSet2) {
      document.getElementById("inf-set-tag-1").style.display = "";
      document.getElementById("inf-section-label").textContent = "Infusion Sets";
      document.getElementById("inf-edit-row-2").classList.remove("hidden");
      document.getElementById("add-set-link").classList.add("hidden");
      populateInfusionDropdowns(2, pd.infusionSet2);
      document.getElementById("inf-qty-2").textContent = String(state.infQty2);
    }

    updateQtyButtons();
  }

  // Cartridges
  if (pd.servingSupplies) {
    document.getElementById("edit-cartridges").style.display = "";
    document.getElementById("cartridge-display").textContent = pd.suppliesType || "Cartridges";
    document.getElementById("cartridge-qty-stepper").textContent = String(state.cartridgeQty);
    updateCartridgeQtyButtons();
  }

  // Snapshot initial state
  state.initialSensorType = document.getElementById("sensor-type-select")?.value || null;
  state.initialInfLabel1 = getInfusionLabel(1);
  state.initialInfIndex1 = getInfusionIndex(1);
  state.initialInfQty1 = state.infQty1;
  state.initialInfLabel2 = getInfusionLabel(2);
  state.initialInfIndex2 = getInfusionIndex(2);
  state.initialInfQty2 = state.infQty2;
}

// ═══════════════════════════════════════════════════════
// INFUSION SET MAPS — identical to original
// ═══════════════════════════════════════════════════════

const INFUSION_MAP = {
  "AutoSoft XC": { "6 mm": { "5\"": 151, "23\"": 107, "32\"": 108, "43\"": 110 }, "9 mm": { "23\"": 153, "43\"": 16 } },
  "AutoSoft 90": { "6 mm": { "23\"": 106, "43\"": 13 }, "9 mm": { "23\"": 4, "43\"": 15 } },
  "AutoSoft 30": { "13 mm": { "23\"": 105, "43\"": 103 } },
  "TruSteel": { "6 mm": { "23\"": 154, "32\"": 155 }, "8 mm": { "23\"": 3, "32\"": 18 } },
  "VariSoft": { "13 mm": { "23\"": 109, "32\"": 12 }, "17 mm": { "23\"": 1 } },
  "Contact": { "6mm": { "23\"": 19 } },
  "Inset": { "6mm": { "23\"": 101 } },
  "Luer": { "6mm": { "32\"": 102 } },
  "Mio Advance Clear": { "9mm": { "23\"": 152 } },
};

const INFUSION_MAP_SET2 = {
  "AutoSoft XC": { "6 mm": { "5\"": 2, "23\"": 4, "32\"": 11, "43\"": 0 }, "9 mm": { "23\"": 6 } },
  "AutoSoft 90": { "6 mm": { "23\"": 9, "43\"": 3 }, "9 mm": { "23\"": 7 } },
  "AutoSoft 30": { "13 mm": { "23\"": 10 } },
  "TruSteel": { "6 mm": { "23\"": 1 } },
  "VariSoft": { "13 mm": { "32\"": 8 } },
};

const PUMP_INFUSION_FILTER = {
  "ilet": ["Contact", "Inset", "Luer"],
  "t:slim": ["AutoSoft XC", "AutoSoft 90", "AutoSoft 30", "TruSteel", "VariSoft"],
  "mobi": ["AutoSoft XC", "AutoSoft 90", "AutoSoft 30", "TruSteel", "VariSoft"],
  "minimed 780g": ["Mio Advance Clear"],
};

function getAllowedBrands() {
  const pumpType = (state.patientData?.suppliesType || "").toLowerCase().trim();
  for (const [key, brands] of Object.entries(PUMP_INFUSION_FILTER)) {
    if (pumpType.includes(key)) return brands;
  }
  return null;
}

function getMapForSet(setNum) { return setNum === 2 ? INFUSION_MAP_SET2 : INFUSION_MAP; }

function parseInfusionLabel(label, setNum) {
  if (!label) return null;
  const map = getMapForSet(setNum || 1);
  const normalized = label.replace(/[\s  ]+/g, ' ').trim().toLowerCase();
  for (const [brand, sizes] of Object.entries(map)) {
    for (const [size, tubings] of Object.entries(sizes)) {
      for (const [tubing, idx] of Object.entries(tubings)) {
        const expected = `${brand} ${size} ${tubing}`.replace(/[\s  ]+/g, ' ').trim().toLowerCase();
        if (normalized === expected) return { brand, size, tubing, index: idx };
      }
    }
  }
  return null;
}

function populateInfusionDropdowns(setNum, currentValue) {
  const brandSelect = document.getElementById(`inf-brand-${setNum}`);
  const sizeSelect = document.getElementById(`inf-size-${setNum}`);
  const tubingSelect = document.getElementById(`inf-tubing-${setNum}`);
  if (!brandSelect || !sizeSelect || !tubingSelect) return;

  const allowedBrands = getAllowedBrands();
  const map = getMapForSet(setNum);
  const brands = Object.keys(map).filter(b => !allowedBrands || allowedBrands.includes(b));
  brandSelect.innerHTML = brands.map(b => `<option value="${escAttr(b)}">${escHtml(b)}</option>`).join("");

  const parsed = parseInfusionLabel(currentValue, setNum);
  if (parsed) {
    brandSelect.value = parsed.brand;
    populateSizeDropdown(setNum, parsed.brand, parsed.size);
    populateTubingDropdown(setNum, parsed.brand, parsed.size, parsed.tubing);
  } else if (brands.length > 0) {
    populateSizeDropdown(setNum, brands[0]);
    const firstSize = Object.keys(map[brands[0]])[0];
    populateTubingDropdown(setNum, brands[0], firstSize);
  }
}

function populateSizeDropdown(setNum, brand, selectValue) {
  const sizeSelect = document.getElementById(`inf-size-${setNum}`);
  const map = getMapForSet(setNum);
  const sizes = Object.keys(map[brand] || {});
  sizeSelect.innerHTML = sizes.map(s => `<option value="${escAttr(s)}">${escHtml(s)}</option>`).join("");
  if (selectValue && sizes.includes(selectValue)) sizeSelect.value = selectValue;
}

function populateTubingDropdown(setNum, brand, size, selectValue) {
  const tubingSelect = document.getElementById(`inf-tubing-${setNum}`);
  const map = getMapForSet(setNum);
  let tubings = Object.keys((map[brand] || {})[size] || {});
  // Block 5" tubing for t:slim — not compatible
  const pumpType = (state.patientData?.suppliesType || "").toLowerCase();
  if (pumpType.includes("t:slim")) {
    tubings = tubings.filter(t => !t.includes('5"'));
  }
  tubingSelect.innerHTML = tubings.map(t => `<option value="${escAttr(t)}">${escHtml(t)}</option>`).join("");
  if (selectValue && tubings.includes(selectValue)) tubingSelect.value = selectValue;
}

function handleSensorTypeChange() {
  const warning = document.getElementById("sensor-compat-warning");
  if (!warning) return;
  const pd = state.patientData;
  const currentVal = document.getElementById("sensor-type-select")?.value || "";
  const changed = currentVal.toLowerCase() !== (pd.sensorsType || "").toLowerCase();
  const hasPump = pd.servingSupplies || pd.servingInfusionSet1;
  if (changed && hasPump) {
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
}

function handleInfBrandChange(setNum) {
  const brand = document.getElementById(`inf-brand-${setNum}`).value;
  const map = getMapForSet(setNum);
  populateSizeDropdown(setNum, brand);
  const firstSize = Object.keys(map[brand] || {})[0];
  populateTubingDropdown(setNum, brand, firstSize);
}

function handleInfSizeChange(setNum) {
  const brand = document.getElementById(`inf-brand-${setNum}`).value;
  const size = document.getElementById(`inf-size-${setNum}`).value;
  populateTubingDropdown(setNum, brand, size);
}

function getInfusionLabel(setNum) {
  const brand = document.getElementById(`inf-brand-${setNum}`)?.value;
  const size = document.getElementById(`inf-size-${setNum}`)?.value;
  const tubing = document.getElementById(`inf-tubing-${setNum}`)?.value;
  if (!brand || !size || !tubing) return "";
  return `${brand} ${size} ${tubing}`;
}

function getInfusionIndex(setNum) {
  const map = getMapForSet(setNum);
  const brand = document.getElementById(`inf-brand-${setNum}`)?.value;
  const size = document.getElementById(`inf-size-${setNum}`)?.value;
  const tubing = document.getElementById(`inf-tubing-${setNum}`)?.value;
  return ((map[brand] || {})[size] || {})[tubing] || null;
}

// ═══════════════════════════════════════════════════════
// PANEL TOGGLE
// ═══════════════════════════════════════════════════════

function togglePanel(id, btn) {
  const panel = document.getElementById("panel-" + id);
  const isOpen = panel.classList.toggle("open");
  btn.textContent = isOpen ? 'Done' : 'Edit';

  // When closing address panel, validate and mark as changed
  if (id === "addr" && !isOpen) {
    const input = document.getElementById("address-input");
    if (input.value.trim() && !state.addressSelectedFromGoogle) {
      // Block close — user typed but didn't pick from dropdown
      panel.classList.add("open");
      btn.textContent = "Done";
      showAddressError();
      return;
    }
    hideAddressError();
    if (input.value.trim() && state.addressSelectedFromGoogle) {
      state.addressChanged = true;
      state.newAddress = input.value.trim();
      // Update display
      const addr = state.newAddress;
      const firstComma = addr.indexOf(",");
      if (firstComma > 0) {
        document.getElementById("address-line1").textContent = addr.slice(0, firstComma).trim();
        document.getElementById("address-line2").textContent = addr.slice(firstComma + 1).trim();
      } else {
        document.getElementById("address-line1").textContent = addr;
        document.getElementById("address-line2").textContent = "";
      }
      checkApartmentWarning(addr);
    }
  }

  // When closing insurance panel, mark as changed if user filled fields
  if (id === "ins" && !isOpen) {
    const insType = document.getElementById("new-insurance-type").value;
    const memberId = document.getElementById("new-member-id").value.trim();
    if (insType && memberId) {
      state.insuranceChanged = true;
    }
  }

  // When closing items panel, update product row display
  if (id === "items" && !isOpen) {
    updateProductRowsFromEdits();
  }
}

// ─── Update product rows after edit ───
function updateProductRowsFromEdits() {
  const pd = state.patientData;

  // Sensors
  if (pd.servingSensors) {
    const newType = document.getElementById("sensor-type-select")?.value;
    if (newType) document.getElementById("prod-sensors-name").textContent = newType;
  }

  // Infusion 1
  if (pd.servingInfusionSet1) {
    document.getElementById("prod-inf1-name").textContent = getInfusionLabel(1) || pd.infusionSet1;
    document.getElementById("prod-inf1-qty").textContent = String(state.infQty1);
    document.getElementById("prod-inf1-unit").textContent = state.infQty1 === 1 ? "box" : "boxes";

    const row2 = document.getElementById("prod-inf2");
    if (state.hasSecondSet) {
      row2.style.display = "";
      document.getElementById("prod-inf2-name").textContent = getInfusionLabel(2) || "Infusion Set 2";
      document.getElementById("prod-inf2-qty").textContent = String(state.infQty2);
      document.getElementById("prod-inf2-unit").textContent = state.infQty2 === 1 ? "box" : "boxes";
    } else if (!pd.servingInfusionSet2) {
      row2.style.display = "none";
    }
  }

  // Cartridges
  if (pd.servingSupplies) {
    document.getElementById("prod-cartridges-qty").textContent = String(state.cartridgeQty);
    document.getElementById("prod-cartridges-unit").textContent = state.cartridgeQty === 1 ? "box" : "boxes";
  }

  updateOop();
}

// ═══════════════════════════════════════════════════════
// SKIP TOGGLES
// ═══════════════════════════════════════════════════════

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// CARTRIDGE QUANTITY STEPPER (1\u20133)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

function stepCartridgeQty(delta) {
  let newVal = state.cartridgeQty + delta;
  newVal = Math.max(1, Math.min(3, newVal));
  state.cartridgeQty = newVal;
  document.getElementById("cartridge-qty-stepper").textContent = String(newVal);
  document.getElementById("prod-cartridges-qty").textContent = String(newVal);
  document.getElementById("prod-cartridges-unit").textContent = newVal === 1 ? "box" : "boxes";
  updateCartridgeQtyButtons();
  updateOop();
}

function updateCartridgeQtyButtons() {
  const row = document.querySelector("#edit-cartridges .qty-row");
  if (!row) return;
  const btns = row.querySelectorAll(".stepper-btn");
  if (btns[0]) btns[0].classList.toggle("at-cap", state.cartridgeQty <= 1);
  if (btns[1]) btns[1].classList.toggle("at-cap", state.cartridgeQty >= 3);
}

// ═══════════════════════════════════════════════════════
// QUANTITY STEPPER — identical logic
// ═══════════════════════════════════════════════════════

function isHighCapInsurance() {
  const ins = (state.patientData?.primaryInsurance || "").toLowerCase();
  return (ins.includes("anthem") && ins.includes("commercial")) ||
         (ins.includes("horizon") && ins.includes("bcbs"));
}

function getCombinedMaxQty() { return isHighCapInsurance() ? 9 : 3; }
function getMaxQty() { return getCombinedMaxQty(); }

function stepQty(setNum, delta) {
  const key = `infQty${setNum}`;
  const otherKey = setNum === 1 ? "infQty2" : "infQty1";
  const combinedMax = getCombinedMaxQty();
  let current = parseInt(state[key], 10) || 0;
  let other = state.hasSecondSet ? (parseInt(state[otherKey], 10) || 0) : 0;
  const minQty = setNum === 1 ? 1 : 0;
  let newVal = current + delta;
  newVal = Math.max(minQty, newVal);
  const roomLeft = combinedMax - other;
  const cappedAtMax = delta > 0 && newVal > roomLeft;
  newVal = Math.min(newVal, roomLeft);
  newVal = Math.max(minQty, newVal);
  state[key] = newVal;
  document.getElementById(`inf-qty-${setNum}`).textContent = String(newVal);

  // Sync to product row in real-time
  const prodQty = document.getElementById(`prod-inf${setNum}-qty`);
  const prodUnit = document.getElementById(`prod-inf${setNum}-unit`);
  if (prodQty) prodQty.textContent = String(newVal);
  if (prodUnit) prodUnit.textContent = newVal === 1 ? "box" : "boxes";

  if (cappedAtMax) showMaxWarning(combinedMax);
  updateQtyButtons();
  updateOop();
}

function showMaxWarning(max) {
  const banner = document.getElementById("max-boxes-banner");
  if (!banner) return;
  document.getElementById("max-boxes-text").textContent = `Maximum ${max} boxes total across all infusion sets`;
  banner.classList.remove("hidden");
  // Re-trigger animation
  banner.style.animation = "none";
  banner.offsetHeight; // force reflow
  banner.style.animation = "";
}

function hideMaxWarning() {
  const banner = document.getElementById("max-boxes-banner");
  if (banner) banner.classList.add("hidden");
}

function updateQtyButtons() {
  const combinedMax = getCombinedMaxQty();
  let anyAtCap = false;
  [1, 2].forEach(setNum => {
    const el = document.getElementById(`inf-qty-${setNum}`);
    if (!el) return;
    const val = parseInt(state[`infQty${setNum}`], 10) || 0;
    const row = document.getElementById(`inf-edit-row-${setNum}`);
    if (!row || row.classList.contains("hidden")) return;
    const otherVal = state.hasSecondSet ? (parseInt(state[setNum === 1 ? "infQty2" : "infQty1"], 10) || 0) : 0;
    const roomLeft = combinedMax - otherVal;
    const btns = row.querySelectorAll(".stepper-btn");
    const minQty = setNum === 1 ? 1 : 0;
    if (btns[0]) btns[0].classList.toggle("at-cap", val <= minQty);
    if (btns[1]) btns[1].classList.toggle("at-cap", val >= roomLeft);
    if (val >= roomLeft) anyAtCap = true;
  });
  // Hide banner when no longer at cap
  if (!anyAtCap) hideMaxWarning();
}

function addSecondSet() {
  state.hasSecondSet = true;
  state.infQty2 = 0;
  document.getElementById("inf-edit-row-2").classList.remove("hidden");
  document.getElementById("add-set-link").classList.add("hidden");
  document.getElementById("inf-set-tag-1").style.display = "";
  document.getElementById("inf-section-label").textContent = "Infusion Sets";
  document.getElementById("inf-qty-2").textContent = "0";
  populateInfusionDropdowns(2, "");
  updateQtyButtons();
}

function removeSecondSet() {
  state.hasSecondSet = false;
  state.infQty2 = 0;
  document.getElementById("inf-edit-row-2").classList.add("hidden");
  document.getElementById("add-set-link").classList.remove("hidden");
  if (!state.patientData?.servingInfusionSet2) {
    document.getElementById("inf-set-tag-1").style.display = "none";
    document.getElementById("inf-section-label").textContent = "Infusion Set";
  }
  updateQtyButtons();
  updateOop();
}

// ═══════════════════════════════════════════════════════
// POSTPONE (1–4 week buttons)
// ═══════════════════════════════════════════════════════

function selectPostpone(weeks) {
  const pd = state.patientData;

  // Deselect if already selected — restore original date
  if (state._selectedPostpone === weeks) {
    state._selectedPostpone = null;
    state.delayDate = null;
    state.delayLessThan20Days = false;
    document.querySelectorAll(".postpone-btn").forEach(btn => { btn.classList.remove("selected"); btn.blur(); });
    document.getElementById("postpone-confirm").classList.add("hidden");
    // Restore original date display
    const orig = pd.nextOrder ? new Date(pd.nextOrder + "T00:00:00") : new Date();
    const origDisplay = orig.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    const origDay = orig.toLocaleDateString("en-US", { weekday: "long" });
    document.getElementById("order-date-display").textContent = `${origDisplay} · ${origDay}`;
    return;
  }

  state._selectedPostpone = weeks;
  const baseDate = pd.nextOrder ? new Date(pd.nextOrder + "T00:00:00") : new Date();
  const newDate = new Date(baseDate);
  newDate.setDate(newDate.getDate() + weeks * 7);

  const dateStr = newDate.toISOString().split("T")[0];
  state.delayDate = dateStr;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((newDate - today) / (1000 * 60 * 60 * 24));
  state.delayLessThan20Days = diffDays < 20;

  // Highlight selected button + blur all to clear iOS focus haze
  document.querySelectorAll(".postpone-btn").forEach((btn, i) => {
    btn.classList.toggle("selected", i + 1 === weeks);
    btn.blur();
  });

  // Show confirmation box
  const dateDisplay = newDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const dayDisplay = newDate.toLocaleDateString("en-US", { weekday: "long" });
  document.getElementById("postpone-date-text").textContent = `${dateDisplay} (${dayDisplay})`;
  document.getElementById("postpone-confirm").classList.remove("hidden");

  // Update the main date display
  document.getElementById("order-date-display").textContent = `${dateDisplay} · ${dayDisplay}`;
}

// ═══════════════════════════════════════════════════════
// INSURANCE
// ═══════════════════════════════════════════════════════

function handleNewInsuranceType() {
  const val = document.getElementById("new-insurance-type").value;
  const otherGroup = document.getElementById("other-insurance-group");
  if (val === "Other") otherGroup.classList.remove("hidden");
  else otherGroup.classList.add("hidden");
  updateInsClearBtn();
}

function updateInsClearBtn() {
  const btn = document.getElementById("ins-clear-btn");
  if (!btn) return;
  const hasType = document.getElementById("new-insurance-type").value !== "";
  const hasMember = document.getElementById("new-member-id").value.trim() !== "";
  const hasFiles = state.uploadedFiles.length > 0;
  if (hasType || hasMember || hasFiles) {
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

function clearInsuranceEdits() {
  document.getElementById("new-insurance-type").value = "";
  document.getElementById("new-member-id").value = "";
  document.getElementById("other-insurance-name").value = "";
  document.getElementById("other-insurance-group").classList.add("hidden");
  state.uploadedFiles = [];
  state.insuranceChanged = false;
  document.getElementById("upload-preview").innerHTML = "";
  document.getElementById("ins-clear-btn").classList.add("hidden");
}

// ═══════════════════════════════════════════════════════
// FILE UPLOAD — identical to original
// ═══════════════════════════════════════════════════════

function handleCardUpload(event) {
  const files = Array.from(event.target.files);
  if (files.length + state.uploadedFiles.length > 2) {
    alert("You can upload a maximum of 2 images (front and back).");
    return;
  }
  files.forEach(file => {
    if (file.size > 10 * 1024 * 1024) {
      alert(`${file.name} is too large. Maximum size is 10MB.`);
      return;
    }
    state.uploadedFiles.push(file);
  });
  renderUploadPreviews();
  event.target.value = "";
}

function renderUploadPreviews() {
  const container = document.getElementById("upload-preview");
  container.innerHTML = "";
  state.uploadedFiles.forEach((file, idx) => {
    const item = document.createElement("div");
    item.className = "preview-item";
    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      item.appendChild(img);
    } else {
      item.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:1.5rem;color:var(--text-muted)"><i class="ti ti-file"></i></div>';
    }
    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×";
    removeBtn.onclick = (e) => { e.stopPropagation(); state.uploadedFiles.splice(idx, 1); renderUploadPreviews(); };
    item.appendChild(removeBtn);
    container.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════
// HELP SECTION
// ═══════════════════════════════════════════════════════

function fillHelp(text) {
  const textarea = document.getElementById("help-msg");
  textarea.value = text;
  textarea.focus();
  state.helpChip = text;
  // Highlight active chip
  document.querySelectorAll(".help-chip").forEach(c => {
    c.classList.toggle("active", c.textContent.trim() === text.replace(/^I have a |^I'd like to /i, "").trim() || c.onclick.toString().includes(text));
  });
}

async function submitCareMessage() {
  const msg = document.getElementById("help-msg")?.value?.trim();
  if (!msg) { alert("Please type a message first."); return; }
  const btn = document.getElementById("care-submit-btn");
  btn.disabled = true;
  btn.textContent = "Sending...";
  try {
    await apiFetch("/api/help-message", {
      method: "POST",
      body: JSON.stringify({
        helpMessage: msg,
        helpChip: state.helpChip,
      }),
    });
    btn.textContent = "Sent!";
    document.getElementById("help-msg").value = "";
    setTimeout(() => { btn.textContent = "Submit To Care Team"; btn.disabled = false; }, 3000);
  } catch (err) {
    console.error("Care message error:", err);
    btn.textContent = "Submit To Care Team";
    btn.disabled = false;
    alert("Couldn't send your message. Please try again.");
  }
}

// ═══════════════════════════════════════════════════════
// OOP ESTIMATE — total only (no deductible/coinsurance)
// ═══════════════════════════════════════════════════════

function updateOop() {
  if (!state.patientData) return;

  const warningCard = document.getElementById("insurance-warning-card");
  const card = document.getElementById("oop-card");
  const activeStatus = (state.patientData.activeStatus || "").toLowerCase().trim();

  // If Inactive or Medicare Advantage — show warning, hide OOP
  if (activeStatus === "inactive" || activeStatus === "medicare advantage") {
    if (warningCard) warningCard.style.display = "";
    card.style.display = "none";
    return;
  }

  // Otherwise hide warning, show OOP as normal
  if (warningCard) warningCard.style.display = "none";

  const est = getOopEstimate();
  if (!est || !est.ok || !est.canCalculateCosts) { card.style.display = "none"; return; }
  card.style.display = "";
  document.getElementById("oop-total").textContent = fmt(est.patientOwes || 0);

  // Supply duration: Medicaid = 60 day, everything else = 90 day
  const ins = (state.patientData.primaryInsurance || "").toLowerCase();
  const isMedicaid = ins.includes("medicaid");
  const durEl = document.getElementById("supply-duration");
  if (durEl) durEl.textContent = isMedicaid ? "60-Day Supply" : "90-Day Supply";
}

function getOopEstimate() {
  const pd = state.patientData;
  if (!pd || !pd.primaryInsurance) return null;
  if ((pd.referralSource || "").toLowerCase().includes("carecentrix")) return null;
  if (pd.primaryInsurance === "Horizon BCBS") return null;

  const hasCgm = pd.servingSensors;
  const hasPump = pd.servingSupplies || pd.servingInfusionSet1 || pd.servingInfusionSet2;
  let serving = "";
  if (hasCgm && hasPump) serving = "CGM & Pump & Supplies";
  else if (hasCgm) serving = "CGM";
  else if (hasPump) serving = "Pump & Supplies";

  const infusionSets = state.infQty1 + (state.hasSecondSet ? state.infQty2 : 0);

  return estimateOop({
    primaryInsurance: pd.primaryInsurance,
    secondaryInsurance: pd.secondaryInsurance || "",
    serving: serving,
    infusionSets: infusionSets || 3,
    deductibleRemaining: pd.deductibleRemaining || "",
    stediCoinsurance: pd.stediCoinsurance || "",
    oopMaxRemaining: pd.oopMaxRemaining || "",
  });
}

// ═══════════════════════════════════════════════════════
// SUBMISSION — builds the same payload as original
// ═══════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════
// SUBMIT PROGRESS OVERLAY
// ═══════════════════════════════════════════════════════

function showSubmitOverlay() {
  let overlay = document.getElementById("submit-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "submit-overlay";
    overlay.className = "submit-overlay";
    overlay.innerHTML = `
      <div class="progress-icon"></div>
      <div class="progress-msg" id="progress-msg">Preparing your changes...</div>
      <div class="progress-sub">This usually takes just a few seconds</div>
      <div class="progress-steps" id="progress-steps">
        <div class="step active" id="step-0"><span class="step-dot"></span>Reviewing your order</div>
        <div class="step" id="step-1"><span class="step-dot"></span>Saving to your account</div>
        <div class="step" id="step-2"><span class="step-dot"></span>Confirming receipt</div>
      </div>
    `;
    document.body.appendChild(overlay);
  }
  // Reset all steps
  overlay.querySelectorAll(".step").forEach((s, i) => {
    s.className = i === 0 ? "step active" : "step";
    s.querySelector(".step-dot").textContent = "";
  });
  document.getElementById("progress-msg").textContent = "Preparing your changes...";
  requestAnimationFrame(() => overlay.classList.add("visible"));

  // Advance steps on timers (visual pacing — real completion comes from API)
  overlay._timers = [
    setTimeout(() => advanceStep(0, "Reviewing your order"), 800),
    setTimeout(() => {
      advanceStep(1, "Saving to your account");
      document.getElementById("progress-msg").textContent = "Updating your records...";
    }, 2000),
    setTimeout(() => {
      advanceStep(2, "Confirming receipt");
      document.getElementById("progress-msg").textContent = "Almost there...";
    }, 4000),
  ];
}

function advanceStep(index, label) {
  // Mark previous steps as done
  for (let i = 0; i < index; i++) {
    const prev = document.getElementById("step-" + i);
    if (prev) {
      prev.className = "step done";
      prev.querySelector(".step-dot").textContent = "\u2713";
    }
  }
  // Mark current as active
  const curr = document.getElementById("step-" + index);
  if (curr) curr.className = "step active";
}

function completeOverlay(success) {
  const overlay = document.getElementById("submit-overlay");
  if (!overlay) return;
  // Clear timers
  (overlay._timers || []).forEach(clearTimeout);
  if (success) {
    // Mark all done
    overlay.querySelectorAll(".step").forEach(s => {
      s.className = "step done";
      s.querySelector(".step-dot").textContent = "\u2713";
    });
    document.getElementById("progress-msg").textContent = "All set!";
  }
}

function hideOverlay() {
  const overlay = document.getElementById("submit-overlay");
  if (overlay) {
    (overlay._timers || []).forEach(clearTimeout);
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 300);
  }
}

async function handleSubmit() {
  // Validate address — block if user typed anything without selecting from dropdown
  // Catches both open and closed panel states
  const addrInput = document.getElementById("address-input");
  if (addrInput.value.trim() && !state.addressSelectedFromGoogle) {
    // Open the panel so the error is visible
    const addrPanel = document.getElementById("panel-addr");
    if (!addrPanel.classList.contains("open")) {
      addrPanel.classList.add("open");
      const addrBtn = addrPanel.closest(".card").querySelector(".card-edit");
      if (addrBtn) addrBtn.textContent = "Done";
    }
    showAddressError();
    return;
  }

  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin .7s linear infinite"></i> Submitting...';

  // Fresh key each submit so changed form data isn't masked by a cached response.
  // On network error (catch block), we preserve the key so a pure retry is safe.
  if (!state._retryingSubmit) {
    state._idempotencyKey = crypto.randomUUID();
  }
  state._retryingSubmit = false;

  try {
    const submission = buildSubmission();

    btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin .7s linear infinite"></i> Saving...';
    showSubmitOverlay();

    // Build request — multipart if files, JSON otherwise
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let res;
    try {
      const headers = {
        "X-Idempotency-Key": state._idempotencyKey,
        ...(state.sessionToken ? { Authorization: `Bearer ${state.sessionToken}` } : {}),
      };

      let body;
      if (state.uploadedFiles.length > 0) {
        // Multipart: files + JSON payload together
        const formData = new FormData();
        state.uploadedFiles.forEach(f => formData.append("cards", f));
        formData.append("submission", JSON.stringify(submission));
        body = formData;
        // Don't set Content-Type — browser sets it with boundary
      } else {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(submission);
      }

      res = await fetch(`${API_BASE}/api/submit`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers,
        body,
      });
    } finally {
      clearTimeout(timeout);
    }

    const result = await res.json();

    if (res.ok && result.success) {
      // Key is single-use — fresh key generated on next submit
      completeOverlay(true);
      await new Promise(r => setTimeout(r, 600));
      hideOverlay();
      showSuccess(result.message);
    } else if (res.status === 207 || result.partial) {
      hideOverlay();
      // Fresh key will be generated on next submit
      alert("Some of your information couldn't be saved. Please reload the page and try again. If the problem continues, text or call us.");
      btn.disabled = false;
      btn.textContent = 'Confirm';
    } else if (res.status === 409) {
      hideOverlay();
      alert(result.error || "Your form is already being submitted. Please wait a moment.");
      btn.disabled = false;
      btn.textContent = 'Confirm';
    } else if (result.error) {
      hideOverlay();
      alert(result.error);
      btn.disabled = false;
      btn.textContent = 'Confirm';
    } else {
      hideOverlay();
      alert("Something went wrong saving your form. Please reload the page and try again.");
      btn.disabled = false;
      btn.textContent = 'Confirm';
    }
  } catch (err) {
    console.error("Submit error:", err);
    hideOverlay();
    // Keep idempotency key AND flag as retry so next submit reuses it
    state._retryingSubmit = true;
    const msg = err.name === "AbortError"
      ? "The request is taking too long. Your internet may be slow — please tap Confirm again to retry."
      : "We couldn't reach our server. Please check your connection and tap Confirm again.";
    alert(msg);
    btn.disabled = false;
    btn.textContent = 'Confirm';
  }
}

function buildSubmission() {
  const pd = state.patientData;

  // Determine response type: if date was edited → delay, otherwise → confirm
  const dateChanged = state.delayDate && state.delayDate !== state.originalDate;
  const response = dateChanged ? "delay" : "confirm";

  const submission = {
    response,
    currentOrderDate: pd.nextOrder || null,
    isAnthemOrCigna: getMaxQty() === 9,
  };

  // Delay fields
  if (response === "delay") {
    submission.indefinite = false;
    submission.newOrderDate = state.delayDate;
    submission.delayLessThan20Days = state.delayLessThan20Days;
  }

  // Order changes
  const orderChanges = {};

  if (pd.servingSensors) {
    orderChanges.sensorsType = document.getElementById("sensor-type-select")?.value || null;
  }

  if (pd.servingSupplies) {
    orderChanges.cartridgeQty = state.cartridgeQty;
  }

  if (pd.servingInfusionSet1) {
    orderChanges.infusionSet1 = getInfusionLabel(1) || null;
    orderChanges.infusionSet1Index = getInfusionIndex(1);
    orderChanges.infQty1 = state.infQty1;
  }

  if (state.hasSecondSet) {
    orderChanges.infusionSet2 = getInfusionLabel(2) || null;
    orderChanges.infusionSet2Index = getInfusionIndex(2);
    orderChanges.infQty2 = state.infQty2;
  } else if (pd.servingInfusionSet2) {
    orderChanges.infusionSet2 = getInfusionLabel(2) || pd.infusionSet2;
    orderChanges.infusionSet2Index = getInfusionIndex(2);
    orderChanges.infQty2 = state.infQty2;
  }

  submission.orderChanges = orderChanges;

  // Address — check form fields directly (user may not have closed the panel)
  const addrInput = document.getElementById("address-input");
  const addrVal = addrInput?.value?.trim();
  if (addrVal && state.addressSelectedFromGoogle) {
    state.addressChanged = true;
    state.newAddress = addrVal;
    submission.addressChange = {
      address: state.newAddress,
      lat: state.addressCoords.lat,
      lng: state.addressCoords.lng,
    };
  } else if (state.addressChanged && state.newAddress) {
    submission.addressChange = {
      address: state.newAddress,
      lat: state.addressCoords.lat,
      lng: state.addressCoords.lng,
    };
  }

  // Insurance — check form fields directly (user may not have closed the panel)
  const insType = document.getElementById("new-insurance-type").value;
  const insMemberId = document.getElementById("new-member-id").value.trim();
  if (insType && insMemberId) {
    submission.insuranceResponse = "changed";
    submission.newInsuranceType = insType === "Other"
      ? (document.getElementById("other-insurance-name").value.trim() || "Other")
      : insType;
    submission.newMemberId = insMemberId;
  } else {
    submission.insuranceResponse = "confirmed";
  }

  return submission;
}

// ═══════════════════════════════════════════════════════
// GOOGLE PLACES — identical to original
// ═══════════════════════════════════════════════════════

let _mapsLoaded = false;

function loadGooglePlaces(apiKey) {
  if (_mapsLoaded) return;
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
  script.async = true;
  script.onload = () => { _mapsLoaded = true; attachAutocomplete(); };
  document.head.appendChild(script);
}

function attachAutocomplete() {
  const input = document.getElementById("address-input");
  if (!input || !window.google?.maps?.places?.Autocomplete) return;

  input.addEventListener("input", () => {
    state.addressSelectedFromGoogle = false;
    // Hide apt addon when user starts typing a new address
    const aptAddon = document.getElementById("apt-addon");
    if (aptAddon) aptAddon.classList.add("hidden");
  });

  // When user clicks/tabs away without selecting from dropdown, show error immediately
  input.addEventListener("blur", () => {
    // Short delay — Google autocomplete click fires blur before place_changed
    setTimeout(() => {
      if (input.value.trim() && !state.addressSelectedFromGoogle) {
        showAddressError();
      }
    }, 300);
  });

  const autocomplete = new google.maps.places.Autocomplete(input, {
    componentRestrictions: { country: "us" },
    types: ["address"],
    fields: ["address_components", "formatted_address", "geometry"],
  });

  autocomplete.addListener("place_changed", () => {
    const place = autocomplete.getPlace();
    if (!place?.formatted_address) return;
    input.value = place.formatted_address.replace(/(\b\d{5})-\d{4}\b/g, "$1");
    state.newAddress = input.value;
    state.addressSelectedFromGoogle = true;
    state.addressChanged = true;
    // Store the base address (without apt) for the apartment addon
    state._baseAddress = input.value;
    if (place.geometry?.location) {
      state.addressCoords.lat = place.geometry.location.lat();
      state.addressCoords.lng = place.geometry.location.lng();
    }
    hideAddressError();

    // Update the display card immediately + re-check apt warning
    updateAddressDisplay(input.value);
    checkApartmentWarning(input.value);

    // Show apartment addon only if address doesn't already contain one
    const aptPatterns = /\b(apt|apartment|unit|suite|ste|#|floor|fl|bldg|building|rm|room)\b/i;
    const aptAddon = document.getElementById("apt-addon");
    if (aptAddon && !aptPatterns.test(input.value)) {
      aptAddon.classList.remove("hidden");
      document.getElementById("apt-input").value = "";
      document.getElementById("apt-addon-error").classList.add("hidden");
      // Remove any previous success message
      const prevSuccess = aptAddon.querySelector(".apt-addon-success");
      if (prevSuccess) prevSuccess.remove();
    }
  });

  // Store autocomplete reference for apartment re-query
  state._autocompleteInstance = autocomplete;
}

// ═══════════════════════════════════════════════════════
// APARTMENT ADD-ON
// ═══════════════════════════════════════════════════════

function updateAddressDisplay(addr) {
  const fc = addr.indexOf(",");
  if (fc > 0) {
    document.getElementById("address-line1").textContent = addr.slice(0, fc).trim();
    document.getElementById("address-line2").textContent = addr.slice(fc + 1).trim();
  } else {
    document.getElementById("address-line1").textContent = addr;
    document.getElementById("address-line2").textContent = "";
  }
}

function addApartment() {
  const aptInput = document.getElementById("apt-input");
  const aptVal = aptInput?.value?.trim();
  if (!aptVal) return;

  const errEl = document.getElementById("apt-addon-error");
  const btn = document.getElementById("apt-add-btn");
  errEl.classList.add("hidden");

  // Remove any previous success message
  const prevSuccess = document.querySelector(".apt-addon-success");
  if (prevSuccess) prevSuccess.remove();

  const baseAddr = state._baseAddress;
  if (!baseAddr) {
    errEl.classList.remove("hidden");
    return;
  }

  // Build the address with apartment inserted before the first comma
  const fc = baseAddr.indexOf(",");
  let addrWithApt;
  if (fc > 0) {
    addrWithApt = baseAddr.slice(0, fc).trim() + " Apt " + aptVal + baseAddr.slice(fc);
  } else {
    addrWithApt = baseAddr + " Apt " + aptVal;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin .7s linear infinite"></i>';

  // Use Google Geocoder to validate the new address
  if (window.google?.maps?.Geocoder) {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address: addrWithApt }, (results, status) => {
      btn.disabled = false;
      btn.innerHTML = '<i class="ti ti-plus"></i> ADD';

      if (status === "OK" && results?.length > 0) {
        const result = results[0];
        const formatted = result.formatted_address
          .replace(/(\b\d{5})-\d{4}\b/g, "$1")
          .replace(/#(\d)/g, "Apt $1");

        // Update state
        const input = document.getElementById("address-input");
        input.value = formatted;
        state.newAddress = formatted;
        state.addressSelectedFromGoogle = true;
        state.addressChanged = true;
        if (result.geometry?.location) {
          state.addressCoords.lat = result.geometry.location.lat();
          state.addressCoords.lng = result.geometry.location.lng();
        }

        // Update display
        updateAddressDisplay(formatted);
        checkApartmentWarning(formatted);

        // Show success
        const successEl = document.createElement("div");
        successEl.className = "apt-addon-success";
        successEl.innerHTML = '<i class="ti ti-check"></i> Address updated';
        document.getElementById("apt-addon").appendChild(successEl);
        setTimeout(() => successEl.remove(), 3000);
      } else {
        errEl.classList.remove("hidden");
      }
    });
  } else {
    // Fallback: just insert the apartment text directly
    btn.disabled = false;
    btn.innerHTML = '<i class="ti ti-plus"></i> ADD';
    const input = document.getElementById("address-input");
    input.value = addrWithApt;
    state.newAddress = addrWithApt;
    state.addressSelectedFromGoogle = true;
    state.addressChanged = true;
    updateAddressDisplay(addrWithApt);
    checkApartmentWarning(addrWithApt);

    const successEl = document.createElement("div");
    successEl.className = "apt-addon-success";
    successEl.innerHTML = '<i class="ti ti-check"></i> Address updated';
    document.getElementById("apt-addon").appendChild(successEl);
    setTimeout(() => successEl.remove(), 3000);
  }
}

// ═══════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════

function showAddressError() {
  const panel = document.getElementById("panel-addr");
  const card = panel.closest(".card");

  // Show inline error
  const errEl = document.getElementById("address-error");
  if (errEl) {
    errEl.textContent = "Please select an address from the dropdown suggestions.";
    errEl.classList.remove("hidden");
  }

  // Shake the card
  card.classList.remove("shake");
  card.offsetHeight;
  card.classList.add("shake");

  // Scroll to it
  card.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideAddressError() {
  const errEl = document.getElementById("address-error");
  if (errEl) errEl.classList.add("hidden");
}

function showError(msg) {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("error-screen").style.display = "flex";
  document.getElementById("error-message").textContent = msg;
}

function showSuccess(message, opts = {}) {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("app").style.display = "none";
  const screen = document.getElementById("success-screen");
  screen.style.display = "flex";
  document.getElementById("success-message").textContent = message;
  // Hide the "we'll text you" subtitle for already-submitted views
  const sub = document.getElementById("success-sub");
  if (sub && opts.hideSubtext) sub.style.display = "none";
  window.scrollTo(0, 0);
}

function checkApartmentWarning(address) {
  const warning = document.getElementById("apt-warning");
  if (!warning || !address) return;
  const aptPatterns = /\b(apt|apartment|unit|suite|ste|#|floor|fl|bldg|building|rm|room)\b/i;
  if (aptPatterns.test(address)) {
    warning.classList.add("hidden");
  } else {
    warning.classList.remove("hidden");
  }
}

function simplifyInsurance(raw) {
  const map = {
    "Anthem BCBS Commercial": "Anthem / BCBS", "Anthem BCBS Medicaid (JLJ)": "Anthem / BCBS",
    "Anthem BCBS Medicare": "Anthem / BCBS", "Horizon BCBS": "Anthem / BCBS",
    "BCBS Wyoming": "Anthem / BCBS", "Aetna Commercial": "Aetna", "Aetna Medicare": "Aetna",
    "Fidelis Medicaid": "Fidelis", "Fidelis Low-Cost": "Fidelis",
    "Fidelis Commercial": "Fidelis", "Fidelis Medicare": "Fidelis",
    "United Commercial": "United", "United Medicaid": "United", "United Medicare": "United",
    "Medicare A&B": "Medicare", "Medicaid": "Medicaid", "NYSHIP": "NYSHIP",
    "Wellcare": "WellCare", "Humana": "Humana", "Midlands Choice": "Other", "Magnacare": "Other",
  };
  return map[raw] || raw;
}

function maskMemberId(id) {
  if (!id || id.length < 4) return id || "N/A";
  return "*".repeat(id.length - 4) + id.slice(-4);
}

function formatDate(dateStr) {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function fmt(n) { return n.toLocaleString("en-US", { style: "currency", currency: "USD" }); }

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function escAttr(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
