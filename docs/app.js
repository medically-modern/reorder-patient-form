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
  sensorsOptOut: false,
  cartridgesOptOut: false,
  infusionOptOut: false,
  infQty1: 3,
  infQty2: 0,
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
  }

  // Infusion Set 1
  if (pd.servingInfusionSet1) {
    const row = document.getElementById("prod-inf1");
    row.style.display = "";
    document.getElementById("prod-inf1-name").textContent = pd.infusionSet1 || "Infusion Set";
    const qty1 = parseInt(pd.infQty1, 10) || 3;
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
    const qty2 = parseInt(pd.infQty2, 10) || 0;
    state.infQty2 = qty2;
    document.getElementById("prod-inf2-qty").textContent = String(qty2);
    document.getElementById("prod-inf2-unit").textContent = qty2 === 1 ? "box" : "boxes";
  }

  // Cartridges
  if (pd.servingSupplies) {
    const row = document.getElementById("prod-cartridges");
    row.style.display = "";
    document.getElementById("prod-cartridges-name").textContent = (pd.suppliesType || "Pump") + " cartridge";
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
  const tubings = Object.keys((map[brand] || {})[size] || {});
  tubingSelect.innerHTML = tubings.map(t => `<option value="${escAttr(t)}">${escHtml(t)}</option>`).join("");
  if (selectValue && tubings.includes(selectValue)) tubingSelect.value = selectValue;
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

  // When closing address panel, mark as changed if user entered something
  if (id === "addr" && !isOpen) {
    const input = document.getElementById("address-input");
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
    const row = document.getElementById("prod-sensors");
    if (state.sensorsOptOut) {
      row.classList.add("skipped");
    } else {
      row.classList.remove("skipped");
      const newType = document.getElementById("sensor-type-select")?.value;
      if (newType) document.getElementById("prod-sensors-name").textContent = newType;
    }
  }

  // Infusion 1
  if (pd.servingInfusionSet1) {
    const row1 = document.getElementById("prod-inf1");
    if (state.infusionOptOut) {
      row1.classList.add("skipped");
      const row2 = document.getElementById("prod-inf2");
      if (row2) row2.classList.add("skipped");
    } else {
      row1.classList.remove("skipped");
      document.getElementById("prod-inf1-name").textContent = getInfusionLabel(1) || pd.infusionSet1;
      document.getElementById("prod-inf1-qty").textContent = String(state.infQty1);
      document.getElementById("prod-inf1-unit").textContent = state.infQty1 === 1 ? "box" : "boxes";

      const row2 = document.getElementById("prod-inf2");
      if (state.hasSecondSet) {
        row2.style.display = "";
        row2.classList.remove("skipped");
        document.getElementById("prod-inf2-name").textContent = getInfusionLabel(2) || "Infusion Set 2";
        document.getElementById("prod-inf2-qty").textContent = String(state.infQty2);
        document.getElementById("prod-inf2-unit").textContent = state.infQty2 === 1 ? "box" : "boxes";
      } else if (!pd.servingInfusionSet2) {
        row2.style.display = "none";
      }
    }
  }

  // Cartridges
  if (pd.servingSupplies) {
    const row = document.getElementById("prod-cartridges");
    if (state.cartridgesOptOut) {
      row.classList.add("skipped");
    } else {
      row.classList.remove("skipped");
    }
  }

  updateOop();
}

// ═══════════════════════════════════════════════════════
// SKIP TOGGLES
// ═══════════════════════════════════════════════════════

function toggleSkip(section) {
  const btn = document.getElementById(`${section}-skip-btn`);
  const editSection = document.getElementById(`edit-${section}`);

  if (section === "sensors") {
    state.sensorsOptOut = !state.sensorsOptOut;
    btn.classList.toggle("active", state.sensorsOptOut);
    btn.textContent = state.sensorsOptOut ? "Skipping ✓" : "Skip this cycle";
    editSection.classList.toggle("skipped", state.sensorsOptOut);
  }
  if (section === "cartridges") {
    state.cartridgesOptOut = !state.cartridgesOptOut;
    btn.classList.toggle("active", state.cartridgesOptOut);
    btn.textContent = state.cartridgesOptOut ? "Skipping ✓" : "Skip this cycle";
    editSection.classList.toggle("skipped", state.cartridgesOptOut);
  }
  if (section === "infusion") {
    state.infusionOptOut = !state.infusionOptOut;
    btn.classList.toggle("active", state.infusionOptOut);
    btn.textContent = state.infusionOptOut ? "Skipping ✓" : "Skip this cycle";
    editSection.classList.toggle("skipped", state.infusionOptOut);
  }

  updateOop();
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
  let newVal = current + delta;
  newVal = Math.max(0, newVal);
  const roomLeft = combinedMax - other;
  const cappedAtMax = delta > 0 && newVal > roomLeft;
  newVal = Math.min(newVal, roomLeft);
  newVal = Math.max(0, newVal);
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
    if (btns[0]) btns[0].classList.toggle("at-cap", val <= 0);
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
  const baseDate = pd.nextOrder ? new Date(pd.nextOrder + "T00:00:00") : new Date();
  const newDate = new Date(baseDate);
  newDate.setDate(newDate.getDate() + weeks * 7);

  const dateStr = newDate.toISOString().split("T")[0];
  state.delayDate = dateStr;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.ceil((newDate - today) / (1000 * 60 * 60 * 24));
  state.delayLessThan20Days = diffDays < 20;

  // Highlight selected button
  document.querySelectorAll(".postpone-btn").forEach((btn, i) => {
    btn.classList.toggle("selected", i + 1 === weeks);
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
  const est = getOopEstimate();
  const card = document.getElementById("oop-card");
  if (!est || !est.ok || !est.canCalculateCosts) { card.style.display = "none"; return; }
  card.style.display = "";
  document.getElementById("oop-total").textContent = fmt(est.patientOwes || 0);
}

function getOopEstimate() {
  const pd = state.patientData;
  if (!pd || !pd.primaryInsurance) return null;
  if ((pd.referralSource || "").toLowerCase().includes("carecentrix")) return null;
  if (pd.primaryInsurance === "Horizon BCBS") return null;

  const hasCgm = pd.servingSensors && !state.sensorsOptOut;
  const hasPump = (pd.servingSupplies && !state.cartridgesOptOut) || ((pd.servingInfusionSet1 || pd.servingInfusionSet2) && !state.infusionOptOut);
  let serving = "";
  if (hasCgm && hasPump) serving = "CGM & Pump & Supplies";
  else if (hasCgm) serving = "CGM";
  else if (hasPump) serving = "Pump & Supplies";

  const infusionSets = state.infusionOptOut ? 0 : (state.infQty1 + (state.hasSecondSet ? state.infQty2 : 0));

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
        <div class="step" id="step-2"><span class="step-dot"></span>Confirming with care team</div>
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
      advanceStep(2, "Confirming with care team");
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
  // Validate address if user opened the address panel and typed something
  const addrPanel = document.getElementById("panel-addr");
  const addrInput = document.getElementById("address-input");
  if (addrPanel.classList.contains("open") && addrInput.value.trim() && !state.addressSelectedFromGoogle) {
    // Show big red error
    let errEl = document.getElementById("address-error-big");
    if (!errEl) {
      errEl = document.createElement("div");
      errEl.id = "address-error-big";
      errEl.className = "address-error-big";
      errEl.innerHTML = '<i class="ti ti-alert-circle"></i><span>You must select an address from the dropdown suggestions. Please type your address and pick one from the list.</span>';
      addrPanel.appendChild(errEl);
    }
    errEl.classList.remove("hidden");

    // Shake the card
    const addrCard = addrPanel.closest(".card");
    addrCard.classList.remove("shake");
    addrCard.offsetHeight; // force reflow
    addrCard.classList.add("shake");

    // Scroll to it
    addrCard.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin .7s linear infinite"></i> Submitting...';

  try {
    const submission = buildSubmission();

    // Upload insurance cards if any
    if (state.uploadedFiles.length > 0) {
      btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin .7s linear infinite"></i> Uploading files...';
      const formData = new FormData();
      state.uploadedFiles.forEach(f => formData.append("cards", f));
      const uploadRes = await fetch(`${API_BASE}/api/upload-insurance-card`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.sessionToken}` },
        credentials: "include",
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (uploadData.urls) submission.insuranceCardUrls = uploadData.urls;
    }

    btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin .7s linear infinite"></i> Saving...';
    showSubmitOverlay();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let res;
    try {
      res = await fetch(`${API_BASE}/api/submit`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(state.sessionToken ? { Authorization: `Bearer ${state.sessionToken}` } : {}),
        },
        body: JSON.stringify(submission),
      });
    } finally {
      clearTimeout(timeout);
    }

    const result = await res.json();

    if (res.ok && result.success) {
      completeOverlay(true);
      await new Promise(r => setTimeout(r, 600));
      hideOverlay();
      showSuccess(result.message);
    } else if (res.status === 207 || result.partial) {
      hideOverlay();
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
    const msg = err.name === "AbortError"
      ? "The request is taking too long. Your internet may be slow. Please reload the page and try again."
      : "We couldn't reach our server. Please check your connection, reload the page, and try again.";
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
    if (state.sensorsOptOut) {
      orderChanges.sensorsType = null;
      orderChanges.sensorsOptOut = true;
    } else {
      orderChanges.sensorsType = document.getElementById("sensor-type-select")?.value || null;
    }
  }

  if (pd.servingSupplies) {
    if (state.cartridgesOptOut) {
      orderChanges.suppliesType = null;
      orderChanges.cartridgesOptOut = true;
    }
  }

  if (pd.servingInfusionSet1) {
    if (state.infusionOptOut) {
      orderChanges.infusionSet1 = null;
      orderChanges.infQty1 = 0;
      orderChanges.infusionOptOut = true;
    } else {
      orderChanges.infusionSet1 = getInfusionLabel(1) || null;
      orderChanges.infusionSet1Index = getInfusionIndex(1);
      orderChanges.infQty1 = state.infQty1;
    }
  }

  if (state.hasSecondSet && !state.infusionOptOut) {
    orderChanges.infusionSet2 = getInfusionLabel(2) || null;
    orderChanges.infusionSet2Index = getInfusionIndex(2);
    orderChanges.infQty2 = state.infQty2;
  } else if (pd.servingInfusionSet2 && !state.infusionOptOut) {
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

  input.addEventListener("input", () => { state.addressSelectedFromGoogle = false; });

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
    if (place.geometry?.location) {
      state.addressCoords.lat = place.geometry.location.lat();
      state.addressCoords.lng = place.geometry.location.lng();
    }
    document.getElementById("address-error").classList.add("hidden");
    // Hide the big red error if it was showing
    const bigErr = document.getElementById("address-error-big");
    if (bigErr) bigErr.classList.add("hidden");

    // Update the display card immediately + re-check apt warning
    const addr = input.value;
    const fc = addr.indexOf(",");
    if (fc > 0) {
      document.getElementById("address-line1").textContent = addr.slice(0, fc).trim();
      document.getElementById("address-line2").textContent = addr.slice(fc + 1).trim();
    } else {
      document.getElementById("address-line1").textContent = addr;
      document.getElementById("address-line2").textContent = "";
    }
    checkApartmentWarning(addr);
  });
}

// ═══════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════

function showError(msg) {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("error-screen").style.display = "flex";
  document.getElementById("error-message").textContent = msg;
}

function showSuccess(message) {
  document.getElementById("app").style.display = "none";
  const screen = document.getElementById("success-screen");
  screen.style.display = "flex";
  document.getElementById("success-message").textContent = message;
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
