// ═══════════════════════════════════════════════════════
// Reorder Patient Form — Wizard UI
// 5-step wizard with sliding panels
// ═══════════════════════════════════════════════════════

const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:3001"
  : "https://reorder-patient-form-production.up.railway.app";

// ─── State (useReducer-style) ───

const state = {
  currentStep: 1,
  maxReachedStep: 1,
  patientData: null,
  orderOptions: null,
  sessionToken: null,

  // Step 1
  decision: null,           // "confirm" | "delay"
  delayDate: null,
  delayLessThan20Days: false,

  // Step 2
  sensorsOptOut: false,
  cartridgesOptOut: false,
  infusionOptOut: false,
  infQty1: 3,
  infQty2: 0,
  hasSecondSet: false,

  // Snapshots of initial dropdown state (captured after form loads, used for review comparison)
  initialSensorType: null,
  initialInfLabel1: null,
  initialInfIndex1: null,
  initialInfQty1: 0,
  initialInfLabel2: null,
  initialInfIndex2: null,
  initialInfQty2: 0,

  // Step 3
  addressChanged: null,  // null until user selects same/changed
  newAddress: null,
  addressSelectedFromGoogle: false,
  addressCoords: { lat: 0, lng: 0 },

  // Step 4
  insuranceChanged: null,   // null | "no" | "yes"
  uploadedFiles: [],

  // Derived
  isOptionalFlow: false,    // delay >= 20 days means steps 2-4 optional
};

// ─── Lock horizontal swipe on wizard ───
// CSS touch-action: pan-y on body/viewport handles this.
// No JS touchmove handler needed — it interferes with natural vertical scrolling.

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

    renderWizard();
  } catch (err) {
    console.error("Init error:", err);
    showError("Something went wrong loading your information. Please try your link again.");
  }
}

// ─── API helper ───

async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (state.sessionToken) {
    headers["Authorization"] = `Bearer ${state.sessionToken}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers,
    ...opts,
  });
  const data = await res.json();
  if (!res.ok && !data.error) throw new Error(`API error: ${res.status}`);
  return data;
}

// ─── Render wizard ───

function renderWizard() {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("app").style.display = "flex";

  const pd = state.patientData;

  // Set greeting with first name
  const greetingEl = document.getElementById("patient-greeting");
  if (greetingEl && pd.name) {
    const firstName = pd.name.split(" ")[0];
    greetingEl.textContent = `Hey, ${firstName}!`;
  }

  // Step 1: Order date
  const nextOrder = pd.nextOrder;
  if (nextOrder) {
    const d = new Date(nextOrder + "T00:00:00");
    document.getElementById("order-date-display").textContent = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    document.getElementById("order-date-day").textContent = d.toLocaleDateString("en-US", { weekday: "long" });

    // Set delay date input constraints
    const dateInput = document.getElementById("delay-date-input");
    dateInput.min = nextOrder;
    // Max = 8 weeks from next order date
    const maxDate = new Date(d);
    maxDate.setDate(maxDate.getDate() + 56);
    dateInput.max = maxDate.toISOString().split("T")[0];
  } else {
    document.getElementById("order-date-display").textContent = "Not scheduled";
    document.getElementById("order-date-day").textContent = "";
  }

  // Step 2: Populate order details
  renderOrderOptions();

  // Step 3: Address
  const addressEl = document.getElementById("current-address-display");
  const addrText = pd.address || "No address on file";
  addressEl.textContent = addrText;
  applyAddressShrink(addressEl);
  checkApartmentWarning(addrText);

  // Step 4: Insurance
  const insType = pd.primaryInsurance || "Unknown";
  const memberId = pd.memberId1 || "";
  document.getElementById("ins-type-display").textContent = simplifyInsurance(insType);
  document.getElementById("ins-member-display").innerHTML = "Member ID: " + maskMemberId(memberId);

  // Set initial OOP in footer
  updateOopFooter();

  // Add date change listener
  document.getElementById("delay-date-input").addEventListener("change", handleDelayDateChange);

  updateStepIndicator();
}

function renderOrderOptions() {
  const pd = state.patientData;
  const opts = state.orderOptions;

  // Sensors
  const sensorSection = document.getElementById("section-sensors");
  if (pd.servingSensors && opts?.sensorsTypes?.length > 0) {
    sensorSection.style.display = "";
    const select = document.getElementById("sensor-type-select");
    select.innerHTML = opts.sensorsTypes
      .map(o => `<option value="${escAttr(o.label)}" ${o.label.toLowerCase() === (pd.sensorsType || "").toLowerCase() ? "selected" : ""}>${escHtml(o.label)}</option>`)
      .join("");
  } else {
    sensorSection.style.display = "none";
  }

  // Cartridges (read-only display based on pump)
  const cartSection = document.getElementById("section-cartridges");
  if (pd.servingSupplies) {
    cartSection.style.display = "";
    const select = document.getElementById("cartridge-type-select");
    select.innerHTML = `<option selected>${escHtml(pd.suppliesType || "N/A")}</option>`;
  } else {
    cartSection.style.display = "none";
  }

  // Infusion Sets
  const infSection = document.getElementById("section-infusion");
  if (pd.servingInfusionSet1) {
    infSection.style.display = "";

    // Populate brand/size/tubing for set 1
    populateInfusionDropdowns(1, pd.infusionSet1);
    state.infQty1 = parseInt(pd.infQty1, 10) || 3;
    document.getElementById("inf-qty-1").textContent = String(state.infQty1);

    // Set 2
    if (pd.servingInfusionSet2) {
      state.hasSecondSet = true;
      document.getElementById("infusion-row-2").classList.remove("hidden");
      document.getElementById("add-set-link").classList.add("hidden");
      document.getElementById("infusion-label-1").innerHTML = "<span>Set 1</span>";
      populateInfusionDropdowns(2, pd.infusionSet2);
      state.infQty2 = parseInt(pd.infQty2, 10) || 0;
      document.getElementById("inf-qty-2").textContent = String(state.infQty2);
    }

    updateQtyButtons();
  } else {
    infSection.style.display = "none";
  }

  // Snapshot initial dropdown state for review comparison
  state.initialSensorType = document.getElementById("sensor-type-select")?.value || null;
  state.initialInfLabel1 = getInfusionLabel(1);
  state.initialInfIndex1 = getInfusionIndex(1);
  state.initialInfQty1 = state.infQty1;
  state.initialInfLabel2 = getInfusionLabel(2);
  state.initialInfIndex2 = getInfusionIndex(2);
  state.initialInfQty2 = state.infQty2;
}

// ─── Infusion Set Conditional Mapping ───
// Maps brand → sizes → tubing lengths → Monday board status index
// Each combo resolves to a single Monday column index for submission
const INFUSION_MAP = {
  "AutoSoft XC": {
    "6 mm": { "5\"": 151, "23\"": 107, "32\"": 108, "43\"": 110 },
    "9 mm": { "23\"": 153, "43\"": 16 },
  },
  "AutoSoft 90": {
    "6 mm": { "23\"": 106, "43\"": 13 },
    "9 mm": { "23\"": 4, "43\"": 15 },
  },
  "AutoSoft 30": {
    "13 mm": { "23\"": 105, "43\"": 103 },
  },
  "TruSteel": {
    "6 mm": { "23\"": 154, "32\"": 155 },
    "8 mm": { "23\"": 3, "32\"": 18 },
  },
  "VariSoft": {
    "13 mm": { "23\"": 109, "32\"": 12 },
    "17 mm": { "23\"": 1 },
  },
  "Contact": {
    "6mm": { "23\"": 19 },
  },
  "Inset": {
    "6mm": { "23\"": 101 },
  },
  "Luer": {
    "6mm": { "32\"": 102 },
  },
  "Mio Advance Clear": {
    "9mm": { "23\"": 152 },
  },
};

// Infusion Set 2 has fewer options on Monday — separate map with Set 2 indexes
const INFUSION_MAP_SET2 = {
  "AutoSoft XC": {
    "6 mm": { "5\"": 2, "23\"": 4, "32\"": 11, "43\"": 0 },
    "9 mm": { "23\"": 6 },
  },
  "AutoSoft 90": {
    "6 mm": { "23\"": 9, "43\"": 3 },
    "9 mm": { "23\"": 7 },
  },
  "AutoSoft 30": {
    "13 mm": { "23\"": 10 },
  },
  "TruSteel": {
    "6 mm": { "23\"": 1 },
  },
  "VariSoft": {
    "13 mm": { "32\"": 8 },
  },
};

// Pump-type → allowed infusion set brands
const PUMP_INFUSION_FILTER = {
  "ilet":          ["Contact", "Inset", "Luer"],
  "t:slim":        ["AutoSoft XC", "AutoSoft 90", "AutoSoft 30", "TruSteel", "VariSoft"],
  "mobi":          ["AutoSoft XC", "AutoSoft 90", "AutoSoft 30", "TruSteel", "VariSoft"],
  "minimed 780g":  ["Mio Advance Clear"],
};

function getAllowedBrands() {
  const pumpType = (state.patientData?.suppliesType || "").toLowerCase().trim();
  for (const [key, brands] of Object.entries(PUMP_INFUSION_FILTER)) {
    if (pumpType.includes(key)) return brands;
  }
  return null; // no filter — show all
}

// Helper: return the correct infusion map for the given set number
function getMapForSet(setNum) {
  return setNum === 2 ? INFUSION_MAP_SET2 : INFUSION_MAP;
}

// Reverse lookup: Monday index → { brand, size, tubing }
const INFUSION_REVERSE = {};
for (const [brand, sizes] of Object.entries(INFUSION_MAP)) {
  for (const [size, tubings] of Object.entries(sizes)) {
    for (const [tubing, idx] of Object.entries(tubings)) {
      INFUSION_REVERSE[idx] = { brand, size, tubing };
    }
  }
}

// Also map label strings to their index for reverse lookup from label text
function parseInfusionLabel(label, setNum) {
  if (!label) return null;
  const map = getMapForSet(setNum || 1);
  // Collapse all whitespace (including narrow no-break space) and lowercase
  const normalized = label.replace(/[\s  ]+/g, ' ').trim().toLowerCase();
  for (const [brand, sizes] of Object.entries(map)) {
    for (const [size, tubings] of Object.entries(sizes)) {
      for (const [tubing, idx] of Object.entries(tubings)) {
        // Build the expected label from map keys and normalize the same way
        const expected = `${brand} ${size} ${tubing}`.replace(/[\s  ]+/g, ' ').trim().toLowerCase();
        if (normalized === expected) {
          return { brand, size, tubing, index: idx };
        }
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

  // Populate brand dropdown (filtered by pump type)
  const allowedBrands = getAllowedBrands();
  const map = getMapForSet(setNum);
  const brands = Object.keys(map).filter(b => !allowedBrands || allowedBrands.includes(b));
  brandSelect.innerHTML = brands.map(b => `<option value="${escAttr(b)}">${escHtml(b)}</option>`).join("");

  // Try to match current value
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
  if (selectValue && sizes.includes(selectValue)) {
    sizeSelect.value = selectValue;
  }
}

function populateTubingDropdown(setNum, brand, size, selectValue) {
  const tubingSelect = document.getElementById(`inf-tubing-${setNum}`);
  const map = getMapForSet(setNum);
  const tubings = Object.keys((map[brand] || {})[size] || {});
  tubingSelect.innerHTML = tubings.map(t => `<option value="${escAttr(t)}">${escHtml(t)}</option>`).join("");
  if (selectValue && tubings.includes(selectValue)) {
    tubingSelect.value = selectValue;
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

// Get the resolved Monday label for a set's current dropdown state
function getInfusionLabel(setNum) {
  const brand = document.getElementById(`inf-brand-${setNum}`)?.value;
  const size = document.getElementById(`inf-size-${setNum}`)?.value;
  const tubing = document.getElementById(`inf-tubing-${setNum}`)?.value;
  if (!brand || !size || !tubing) return "";
  return `${brand} ${size} ${tubing}`;
}

// Get the Monday status index for a set's current state
function getInfusionIndex(setNum) {
  const map = getMapForSet(setNum);
  const brand = document.getElementById(`inf-brand-${setNum}`)?.value;
  const size = document.getElementById(`inf-size-${setNum}`)?.value;
  const tubing = document.getElementById(`inf-tubing-${setNum}`)?.value;
  return ((map[brand] || {})[size] || {})[tubing] || null;
}

// ─── Wizard Navigation ───

function goToStep(step) {
  if (step < 1 || step > 5) return;

  state.currentStep = step;
  if (step > state.maxReachedStep) state.maxReachedStep = step;

  const track = document.getElementById("wizard-track");
  track.style.transform = `translateX(-${(step - 1) * 100}%)`;

  updateStepIndicator();

  // Scroll to top so the new panel content is visible
  window.scrollTo({ top: 0, behavior: "smooth" });
  const panel = document.getElementById(`panel-${step}`);
  const panelContent = panel?.querySelector(".panel-content");
  if (panelContent) panelContent.scrollTop = 0;

  // Focus first interactive element in new panel
  setTimeout(() => {
    const focusable = panel.querySelector("button, input, select, [tabindex]");
    if (focusable) focusable.focus({ preventScroll: true });
  }, 260);
}

function nextStep() {
  // Validate current step before moving
  if (!validateCurrentStep()) return;

  // If step 5, prepare the review
  if (state.currentStep === 4) {
    renderReview();
  }

  goToStep(state.currentStep + 1);
}

function prevStep() {
  if (state.currentStep > 1) {
    goToStep(state.currentStep - 1);
  }
}

function jumpToStep(step) {
  // Can only jump to completed steps (not future)
  if (step < state.currentStep && step >= 1) {
    goToStep(step);
  }
}

function updateStepIndicator() {
  const circles = document.querySelectorAll(".step-circle");
  circles.forEach((circle, i) => {
    const stepNum = i + 1;
    circle.classList.remove("active", "completed");
    if (stepNum === state.currentStep) {
      circle.classList.add("active");
    } else if (stepNum < state.currentStep) {
      circle.classList.add("completed");
    }
  });

  // Track fill
  const fill = document.getElementById("step-track-fill");
  const pct = ((state.currentStep - 1) / 4) * 100;
  fill.style.width = `${pct}%`;
}

// ─── Step 1: Order Date ───

function selectOrderDecision(value) {
  state.decision = value;

  // Update button states
  document.getElementById("btn-confirm").classList.toggle("selected", value === "confirm");
  document.getElementById("btn-delay").classList.toggle("selected", value === "delay");

  const delayPicker = document.getElementById("delay-picker");
  const footer = document.getElementById("step1-footer");

  if (value === "confirm") {
    delayPicker.classList.add("hidden");
    footer.style.display = "";
    state.delayDate = null;
    state.delayLessThan20Days = false;
    state.isOptionalFlow = false;
  } else if (value === "delay") {
    delayPicker.classList.remove("hidden");
    // Default the calendar to the current order date
    const dateInput = document.getElementById("delay-date-input");
    if (state.patientData?.nextOrder && !dateInput.value) {
      dateInput.value = state.patientData.nextOrder;
    }
    // Don't show continue until date is selected
    footer.style.display = "none";
    state.delayDate = null;
  }
}

function handleDelayDateChange() {
  const dateInput = document.getElementById("delay-date-input");
  const errorDiv = document.getElementById("delay-date-error");
  const note20 = document.getElementById("delay-note-20");
  const dateStr = dateInput.value;

  if (!dateStr) return;

  // Validate bounds
  const pd = state.patientData;
  const currentOrderDate = pd.nextOrder ? new Date(pd.nextOrder + "T00:00:00") : null;
  const selectedDate = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Max 8 weeks from order date
  const maxDate = currentOrderDate ? new Date(currentOrderDate) : new Date(today);
  maxDate.setDate(maxDate.getDate() + 56);

  if (currentOrderDate && selectedDate < currentOrderDate) {
    errorDiv.textContent = "Sorry, your scheduled order date is the earliest insurance will cover your reorder. Please text/call us if there is an extraordinary situation.";
    errorDiv.classList.remove("hidden");
    document.getElementById("step1-footer").style.display = "none";
    return;
  }

  if (selectedDate > maxDate) {
    errorDiv.textContent = "Maximum delay is 8 weeks. Need longer? Text us and we'll help.";
    errorDiv.classList.remove("hidden");
    document.getElementById("step1-footer").style.display = "none";
    return;
  }

  if (selectedDate < today) {
    errorDiv.textContent = "Please select a future date.";
    errorDiv.classList.remove("hidden");
    document.getElementById("step1-footer").style.display = "none";
    return;
  }

  // Valid date
  errorDiv.classList.add("hidden");
  state.delayDate = dateStr;

  // Check if less than 20 days from today
  const diffDays = Math.ceil((selectedDate - today) / (1000 * 60 * 60 * 24));
  state.delayLessThan20Days = diffDays < 20;
  state.isOptionalFlow = diffDays >= 20;

  if (state.delayLessThan20Days) {
    note20.classList.remove("hidden");
  } else {
    note20.classList.add("hidden");
  }

  // Show continue
  document.getElementById("step1-footer").style.display = "";
}

// ─── Cartridge collapsible toggle ───

function toggleCartridgeBody() {
  const body = document.getElementById("cartridges-body");
  const chevron = document.getElementById("cartridge-chevron");
  if (body.classList.contains("collapsed")) {
    body.classList.remove("collapsed");
    body.classList.add("expanded");
    chevron.classList.add("open");
  } else {
    body.classList.remove("expanded");
    body.classList.add("collapsed");
    chevron.classList.remove("open");
  }
}

// ─── Step 2: Order Details ───


// ─── Opt-out button handler ───

function toggleOptOutBtn(section) {
  const btn = document.getElementById(`${section}-optout-btn`);
  const checkbox = document.getElementById(`${section}-optout`);
  if (!btn || !checkbox) return;
  checkbox.checked = !checkbox.checked;
  btn.classList.toggle("active", checkbox.checked);
  toggleOptOut(section);
}

function toggleOptOut(section) {
  const checkbox = document.getElementById(`${section}-optout`);
  const sectionEl = document.getElementById(`section-${section}`);
  const checked = checkbox.checked;

  if (section === "sensors") state.sensorsOptOut = checked;
  if (section === "cartridges") state.cartridgesOptOut = checked;
  if (section === "infusion") state.infusionOptOut = checked;

  sectionEl.classList.toggle("opted-out", checked);

  // Check empty state
  checkEmptyState();
  updateOopFooter();
}

function checkEmptyState() {
  const pd = state.patientData;
  const allOptedOut =
    (!pd.servingSensors || state.sensorsOptOut) &&
    (!pd.servingSupplies || state.cartridgesOptOut) &&
    (!(pd.servingInfusionSet1 || pd.servingInfusionSet2) || state.infusionOptOut);

  const warning = document.getElementById("empty-warning");
  const continueBtn = document.getElementById("step2-continue");

  if (allOptedOut) {
    warning.classList.remove("hidden");
    continueBtn.disabled = true;
  } else {
    warning.classList.add("hidden");
    continueBtn.disabled = false;
  }
}

function stepQty(setNum, delta) {
  const key = `infQty${setNum}`;
  const otherKey = setNum === 1 ? 'infQty2' : 'infQty1';
  const combinedMax = getCombinedMaxQty();

  let current = parseInt(state[key], 10) || 0;
  let other = state.hasSecondSet ? (parseInt(state[otherKey], 10) || 0) : 0;

  let newVal = current + delta;
  newVal = Math.max(0, newVal);

  // Always enforce combined max (set1 + set2 never exceeds combinedMax)
  const roomLeft = combinedMax - other;
  newVal = Math.min(newVal, roomLeft);
  newVal = Math.max(0, newVal);

  state[key] = newVal;
  document.getElementById(`inf-qty-${setNum}`).textContent = String(newVal);
  updateQtyButtons();
  updateOopFooter();
}

function isHighCapInsurance() {
  const ins = (state.patientData?.primaryInsurance || "").toLowerCase();
  return ins.includes("anthem") && ins.includes("commercial") ||
         ins.includes("horizon") && ins.includes("bcbs");
}

function getCombinedMaxQty() {
  return isHighCapInsurance() ? 9 : 3;
}

function getMaxQty() {
  // Keep for backward compat (buildSubmission uses this)
  return getCombinedMaxQty();
}

function updateQtyButtons() {
  const combinedMax = getCombinedMaxQty();

  [1, 2].forEach(setNum => {
    const el = document.getElementById(`inf-qty-${setNum}`);
    if (!el) return;
    const val = parseInt(state[`infQty${setNum}`], 10) || 0;
    const row = document.getElementById(`infusion-row-${setNum}`);
    if (!row || row.classList.contains("hidden")) return;

    const otherVal = state.hasSecondSet ? (parseInt(state[setNum === 1 ? 'infQty2' : 'infQty1'], 10) || 0) : 0;
    const roomLeft = combinedMax - otherVal;

    const btns = row.querySelectorAll(".qty-btn");
    if (btns[0]) btns[0].disabled = val <= 0;
    if (btns[1]) btns[1].disabled = val >= roomLeft;
  });
}

function addSecondSet() {
  state.hasSecondSet = true;
  state.infQty2 = 0;
  document.getElementById("infusion-row-2").classList.remove("hidden");
  document.getElementById("add-set-link").classList.add("hidden");
  document.getElementById("infusion-label-1").innerHTML = "<span>Set 1</span>";
  document.getElementById("inf-qty-2").textContent = "0";

  // Populate set 2 dropdowns
  populateInfusionDropdowns(2, "");
  updateQtyButtons();
}

function removeSecondSet() {
  state.hasSecondSet = false;
  state.infQty2 = 0;
  document.getElementById("infusion-row-2").classList.add("hidden");
  document.getElementById("add-set-link").classList.remove("hidden");
  document.getElementById("infusion-label-1").innerHTML = "";
  updateQtyButtons();
  updateOopFooter();
}

// ─── Step 3: Address ───

function selectAddressChange(changed) {
  state.addressChanged = changed;

  document.getElementById("btn-address-same").classList.toggle("selected", !changed);
  document.getElementById("btn-address-new").classList.toggle("selected", changed);

  const editSection = document.getElementById("address-edit");
  if (changed) {
    editSection.classList.remove("hidden");
  } else {
    editSection.classList.add("hidden");
    state.newAddress = null;
    state.addressSelectedFromGoogle = false;
  }
}

// ─── Step 4: Insurance ───

function selectInsuranceChange(value) {
  state.insuranceChanged = value;

  document.getElementById("btn-ins-same").classList.toggle("selected", value === "no");
  document.getElementById("btn-ins-new").classList.toggle("selected", value === "yes");

  const editSection = document.getElementById("insurance-edit");
  if (value === "yes") {
    editSection.classList.remove("hidden");
  } else {
    editSection.classList.add("hidden");
  }
}

function handleNewInsuranceType() {
  const val = document.getElementById("new-insurance-type").value;
  const otherGroup = document.getElementById("other-insurance-group");
  if (val === "Other") {
    otherGroup.classList.remove("hidden");
  } else {
    otherGroup.classList.add("hidden");
  }
}

// ─── File Upload ───

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
      item.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;font-size:2rem;">📄</div>`;
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "×";
    removeBtn.onclick = (e) => {
      e.stopPropagation();
      state.uploadedFiles.splice(idx, 1);
      renderUploadPreviews();
    };
    item.appendChild(removeBtn);
    container.appendChild(item);
  });
}

// ─── Validation ───

function validateCurrentStep() {
  const step = state.currentStep;

  if (step === 1) {
    if (!state.decision) return false;
    if (state.decision === "delay" && !state.delayDate) return false;
    return true;
  }

  if (step === 2) {
    // Check empty state
    const pd = state.patientData;
    const allOptedOut =
      (!pd.servingSensors || state.sensorsOptOut) &&
      (!pd.servingSupplies || state.cartridgesOptOut) &&
      (!(pd.servingInfusionSet1 || pd.servingInfusionSet2) || state.infusionOptOut);
    if (allOptedOut) return false;
    return true;
  }

  if (step === 3) {
    if (state.addressChanged === null) {
      alert("Please confirm whether your address is the same or has changed.");
      return false;
    }
    if (state.addressChanged) {
      const addr = document.getElementById("address-input").value.trim();
      if (!addr) {
        showFieldError("address-error", "Please enter your new address.");
        return false;
      }
      if (!state.addressSelectedFromGoogle) {
        showFieldError("address-error", "Please select your address from the dropdown suggestions.");
        return false;
      }
      state.newAddress = addr;
    }
    return true;
  }

  if (step === 4) {
    if (state.insuranceChanged === null) {
      alert("Please confirm whether your insurance is the same or has changed.");
      return false;
    }
    if (state.insuranceChanged === "yes") {
      const insType = document.getElementById("new-insurance-type").value;
      if (!insType) {
        alert("Please select your new insurance type.");
        return false;
      }
      const memberId = document.getElementById("new-member-id").value.trim();
      if (!memberId) {
        alert("Please enter your new member ID.");
        return false;
      }
    }
    return true;
  }

  return true;
}

function showFieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = msg;
    el.classList.remove("hidden");
  }
}

// ─── Step 5: Review & Confirm ───

function renderReview() {
  const pd = state.patientData;
  const diffContainer = document.getElementById("review-diff");
  let html = "";
  let hasChanges = false;

  // Order date
  if (state.decision === "delay" && state.delayDate) {
    hasChanges = true;
    html += reviewItem("Next order date", formatDate(pd.nextOrder), formatDate(state.delayDate));
  }

  // Order changes — compare current dropdown state against initial snapshot
  // (avoids all Monday label format / whitespace / type-coercion mismatches)
  if (!state.sensorsOptOut && pd.servingSensors) {
    const newSensor = document.getElementById("sensor-type-select")?.value;
    if (newSensor && newSensor !== state.initialSensorType) {
      hasChanges = true;
      html += reviewItem("Sensor type", state.initialSensorType || "—", newSensor);
    }
  }
  if (state.sensorsOptOut && pd.servingSensors) {
    hasChanges = true;
    html += reviewItem("CGM Sensors", state.initialSensorType || "Ordered", "Skipping this order");
  }

  if (!state.infusionOptOut && (pd.servingInfusionSet1 || pd.servingInfusionSet2)) {
    // Fuzzy match: strip ALL whitespace and lowercase, so "AutoSoft 90 6 mm  23""
    // and "AutoSoft 90 6 mm 23"" and "AutoSoft 90 6mm 23"" all compare as equal.
    // This is ONLY for the review display — the actual Monday submission uses indexes.
    const fuzzy = (s) => (s || "").replace(/\s+/g, "").toLowerCase();
    const newLabel1 = getInfusionLabel(1);
    const newLabel2 = state.hasSecondSet ? getInfusionLabel(2) : "";
    const typeChanged1 = fuzzy(newLabel1) !== fuzzy(pd.infusionSet1);
    const typeChanged2 = state.hasSecondSet && fuzzy(newLabel2) !== fuzzy(pd.infusionSet2);
    const qtyChanged1 = state.infQty1 !== state.initialInfQty1;
    const qtyChanged2 = state.hasSecondSet && state.infQty2 !== state.initialInfQty2;
    if (typeChanged1 || typeChanged2 || qtyChanged1 || qtyChanged2) {
      hasChanges = true;
      const origDesc = `${pd.infusionSet1 || "Set 1"} (${state.initialInfQty1})` + (state.initialInfQty2 > 0 ? ` + ${pd.infusionSet2 || "Set 2"} (${state.initialInfQty2})` : "");
      let newDesc = `${newLabel1} (${state.infQty1})`;
      if (state.hasSecondSet && state.infQty2 > 0) {
        newDesc += ` + ${newLabel2} (${state.infQty2})`;
      }
      html += reviewItem("Infusion sets", origDesc, newDesc);
    }
  }
  if (state.infusionOptOut && (pd.servingInfusionSet1 || pd.servingInfusionSet2)) {
    hasChanges = true;
    html += reviewItem("Infusion Sets", "Ordered", "Skipping this order");
  }

  // Cartridges opt-out
  if (state.cartridgesOptOut && pd.servingSupplies) {
    hasChanges = true;
    html += reviewItem("Cartridges", pd.suppliesType || "Ordered", "Skipping this order");
  }

  // Address
  if (state.addressChanged && state.newAddress) {
    hasChanges = true;
    html += reviewItem("Address", pd.address || "—", state.newAddress, true);
  } else {
    // Show "Same as on file" for insurance context
  }

  // Insurance
  if (state.insuranceChanged === "yes") {
    hasChanges = true;
    let newIns = document.getElementById("new-insurance-type").value;
    if (newIns === "Other") newIns = document.getElementById("other-insurance-name").value.trim() || "Other";
    html += reviewItem("Insurance", simplifyInsurance(pd.primaryInsurance || "—"), newIns);
  }

  if (!hasChanges) {
    html = '<div class="review-no-changes">Confirming your order as scheduled. Nothing has changed.</div>';
  }

  diffContainer.innerHTML = html;

  // OOP in review
  updateReviewOop();
}

function reviewItem(label, before, after, isAddress) {
  const addrStyle = isAddress ? ' style="word-break:break-word;overflow-wrap:break-word;"' : '';
  return `<div class="review-item">
    <div class="review-item-label">${escHtml(label)}</div>
    <div class="review-item-before"${addrStyle}>${escHtml(before)}</div>
    <div class="review-item-arrow">→</div>
    <div class="review-item-after"${addrStyle}>${escHtml(after)}</div>
  </div>`;
}

// ─── OOP Footer ───

function updateOopFooter() {
  if (!state.patientData) return;

  const est = getOopEstimate();
  if (!est || !est.ok || !est.canCalculateCosts) {
    document.getElementById("footer-deductible").textContent = "—";
    document.getElementById("footer-coinsurance").textContent = "—";
    document.getElementById("footer-total").textContent = "—";
    return;
  }

  document.getElementById("footer-deductible").textContent = fmt(est.appliedDeductible || 0);
  document.getElementById("footer-coinsurance").textContent = fmt(est.patientCoinsurance || 0);
  document.getElementById("footer-total").textContent = fmt(est.patientOwes || 0);
}

function updateReviewOop() {
  const est = getOopEstimate();
  const el = document.getElementById("review-total");
  if (!est || !est.ok || !est.canCalculateCosts) {
    el.textContent = "—";
  } else {
    el.textContent = fmt(est.patientOwes || 0);
  }
}

function getOopEstimate() {
  const pd = state.patientData;
  if (!pd || !pd.primaryInsurance) return null;

  // CareCentrix check
  if ((pd.referralSource || "").toLowerCase().includes("carecentrix")) return null;

  const serving = deriveServing();
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

function deriveServing() {
  const pd = state.patientData;
  if (!pd) return "";
  const hasCgm = pd.servingSensors && !state.sensorsOptOut;
  const hasPump = (pd.servingSupplies && !state.cartridgesOptOut) || ((pd.servingInfusionSet1 || pd.servingInfusionSet2) && !state.infusionOptOut);
  if (hasCgm && hasPump) return "CGM & Pump & Supplies";
  if (hasCgm) return "CGM";
  if (hasPump) return "Pump & Supplies";
  return "";
}

// ─── Submission ───

async function handleSubmit() {
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting...";

  try {
    const submission = buildSubmission();

    // Upload insurance cards if any
    if (state.uploadedFiles.length > 0) {
      btn.textContent = "Uploading files...";
      const formData = new FormData();
      state.uploadedFiles.forEach(f => formData.append("cards", f));

      const uploadRes = await fetch(`${API_BASE}/api/upload-insurance-card`, {
        method: "POST",
        headers: { Authorization: `Bearer ${state.sessionToken}` },
        credentials: "include",
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (uploadData.urls) {
        submission.insuranceCardUrls = uploadData.urls;
      }
    }

    btn.textContent = "Saving...";
    const result = await apiFetch("/api/submit", {
      method: "POST",
      body: JSON.stringify(submission),
    });

    if (result.success) {
      showSuccess(result.message);
    } else {
      alert(result.message || "There was an issue saving your form. Please try again.");
      btn.disabled = false;
      btn.textContent = "Submit Order";
    }
  } catch (err) {
    console.error("Submit error:", err);
    document.getElementById("network-error").classList.remove("hidden");
    btn.disabled = false;
    btn.textContent = "Submit Order";
  }
}

function buildSubmission() {
  const pd = state.patientData;
  const submission = {
    response: state.decision,
    currentOrderDate: pd.nextOrder || null,
    isAnthemOrCigna: getMaxQty() === 9,
  };

  // Delay fields
  if (state.decision === "delay") {
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

  // Address
  if (state.addressChanged && state.newAddress) {
    submission.addressChange = {
      address: state.newAddress,
      lat: state.addressCoords.lat,
      lng: state.addressCoords.lng,
    };
  }

  // Insurance
  if (state.insuranceChanged === "yes") {
    submission.insuranceResponse = "changed";
    let insType = document.getElementById("new-insurance-type").value;
    if (insType === "Other") {
      insType = document.getElementById("other-insurance-name").value.trim() || "Other";
    }
    submission.newInsuranceType = insType;
    submission.newMemberId = document.getElementById("new-member-id").value.trim();
  } else {
    submission.insuranceResponse = "confirmed";
  }

  return submission;
}

// ─── Success ───

function showSuccess(message) {
  document.getElementById("app").style.display = "none";
  document.getElementById("success-screen").style.display = "flex";
  document.getElementById("success-message").textContent = message;
}

// ─── Google Places ───

let _mapsLoaded = false;

function loadGooglePlaces(apiKey) {
  if (_mapsLoaded) return;
  const script = document.createElement("script");
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
  script.async = true;
  script.onload = () => {
    _mapsLoaded = true;
    attachAutocomplete();
  };
  document.head.appendChild(script);
}

function attachAutocomplete() {
  const input = document.getElementById("address-input");
  if (!input || !window.google?.maps?.places?.Autocomplete) return;

  // Reset selection flag when user manually types
  input.addEventListener("input", () => {
    state.addressSelectedFromGoogle = false;
  });

  const autocomplete = new google.maps.places.Autocomplete(input, {
    componentRestrictions: { country: "us" },
    types: ["address"],
    fields: ["address_components", "formatted_address", "geometry"],
  });

  autocomplete.addListener("place_changed", () => {
    const place = autocomplete.getPlace();
    if (!place?.formatted_address) return;

    // Strip +4 ZIP
    input.value = place.formatted_address.replace(/(\b\d{5})-\d{4}\b/g, "$1");
    state.newAddress = input.value;
    state.addressSelectedFromGoogle = true;
      checkApartmentWarning(state.newAddress);

    if (place.geometry?.location) {
      state.addressCoords.lat = place.geometry.location.lat();
      state.addressCoords.lng = place.geometry.location.lng();
    }

    // Hide error
    document.getElementById("address-error").classList.add("hidden");
  });
}

// ─── Utilities ───

function showError(msg) {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("error-screen").style.display = "flex";
  document.getElementById("error-message").textContent = msg;
}

function formatDate(dateStr) {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function maskMemberId(id) {
  if (!id || id.length < 4) return id || "N/A";
  const masked = "*".repeat(id.length - 4) + id.slice(-4);
  return `<span class="member-id-mask">${masked}</span>`;
}

// ─── Address shrink for long text ───

// ─── Apartment/unit number warning ───

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

function applyAddressShrink(el) {
  // Reset to default size first
  el.style.fontSize = "";
  el.style.wordBreak = "";
  el.style.overflowWrap = "";
  // Wait for render, then scale text to fill available width on ONE line
  requestAnimationFrame(() => {
    const parent = el.parentElement;
    if (!parent) return;
    const maxWidth = parent.clientWidth - 32; // account for padding
    const minFontSize = 11;
    const maxFontSize = 24;
    let fontSize = 16; // start at 1rem

    // Force single-line measurement so we only "fit" when truly one line
    el.style.whiteSpace = "nowrap";
    el.style.overflow = "hidden";
    el.style.fontSize = fontSize + "px";

    if (el.scrollWidth > maxWidth) {
      // Shrink until it fits on one line
      while (el.scrollWidth > maxWidth && fontSize > minFontSize) {
        fontSize -= 0.5;
        el.style.fontSize = fontSize + "px";
      }
    } else {
      // Grow for short addresses until we approach maxWidth
      while (fontSize < maxFontSize) {
        fontSize += 0.5;
        el.style.fontSize = fontSize + "px";
        if (el.scrollWidth > maxWidth) {
          fontSize -= 0.5;
          el.style.fontSize = fontSize + "px";
          break;
        }
      }
    }

    // Keep nowrap + hidden so text stays on one line and clips if needed
    el.style.textOverflow = "ellipsis";
  });
}

function simplifyInsurance(raw) {
  // Map raw Monday labels to patient-friendly names
  const map = {
    "Anthem BCBS Commercial": "Anthem BCBS",
    "Anthem BCBS Medicaid (JLJ)": "Anthem BCBS",
    "Anthem BCBS Medicare": "Anthem BCBS",
    "Horizon BCBS": "Anthem BCBS",
    "BCBS Wyoming": "Anthem BCBS",
    "Aetna Commercial": "Aetna",
    "Aetna Medicare": "Aetna",
    "Fidelis Medicaid": "Fidelis",
    "Fidelis Low-Cost": "Fidelis",
    "Fidelis Commercial": "Fidelis",
    "Fidelis Medicare": "Fidelis",
    "United Commercial": "United",
    "United Medicaid": "United",
    "United Medicare": "United",
    "Medicare A&B": "Medicare",
    "Medicaid": "Medicaid",
    "NYSHIP": "NYSHIP",
    "Wellcare": "WellCare",
    "Humana": "Humana",
    "Midlands Choice": "Other",
    "Magnacare": "Other",
  };
  return map[raw] || raw;
}

function fmt(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function escAttr(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
