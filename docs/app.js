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

  // Step 3
  addressChanged: false,
  newAddress: null,
  addressCoords: { lat: 0, lng: 0 },

  // Step 4
  insuranceChanged: null,   // null | "no" | "yes"
  uploadedFiles: [],

  // Derived
  isOptionalFlow: false,    // delay >= 20 days means steps 2-4 optional
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
  document.getElementById("current-address-display").textContent = pd.address || "No address on file";

  // Step 4: Insurance
  const insType = pd.primaryInsurance || "Unknown";
  const memberId = pd.memberId1 || "";
  document.getElementById("ins-type-display").textContent = simplifyInsurance(insType);
  document.getElementById("ins-member-display").textContent = "Member ID: " + maskMemberId(memberId);

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
  if (pd.servingInfusionSet1 && opts?.infusionSets?.length > 0) {
    infSection.style.display = "";

    // Populate type/dimension for set 1
    populateInfusionDropdowns(1, pd.infusionSet1);
    state.infQty1 = pd.infQty1 || 3;
    document.getElementById("inf-qty-1").textContent = state.infQty1;

    // Set 2
    if (pd.servingInfusionSet2) {
      state.hasSecondSet = true;
      document.getElementById("infusion-row-2").classList.remove("hidden");
      document.getElementById("add-set-link").classList.add("hidden");
      document.getElementById("infusion-label-1").innerHTML = "<span>Set 1</span>";
      populateInfusionDropdowns(2, pd.infusionSet2);
      state.infQty2 = pd.infQty2 || 0;
      document.getElementById("inf-qty-2").textContent = state.infQty2;
    }

    updateInfusionTotal();
    updateQtyButtons();
  } else {
    infSection.style.display = "none";
  }
}

function populateInfusionDropdowns(setNum, currentValue) {
  const opts = state.orderOptions;
  if (!opts?.infusionSets?.length) return;

  const typeSelect = document.getElementById(`inf-type-${setNum}`);
  const dimSelect = document.getElementById(`inf-dim-${setNum}`);

  // Extract unique types from the infusion set labels
  // Labels are like "Autosoft XC 6mm / 23in" — type is first part, dimension is last part
  const allLabels = opts.infusionSets.map(o => o.label);

  // For now, populate the type dropdown with all infusion set labels
  // (the spec says type + dimension cascading, but existing data has combined labels)
  typeSelect.innerHTML = allLabels
    .map(label => `<option value="${escAttr(label)}" ${label.toLowerCase() === (currentValue || "").toLowerCase() ? "selected" : ""}>${escHtml(label)}</option>`)
    .join("");

  // Dimension dropdown: hidden for now since combined labels
  dimSelect.parentElement.style.display = "none";
}

function handleInfTypeChange(setNum) {
  // If we implement cascading dropdowns later, handle here
}

// ─── Wizard Navigation ───

function goToStep(step) {
  if (step < 1 || step > 5) return;

  state.currentStep = step;
  if (step > state.maxReachedStep) state.maxReachedStep = step;

  const track = document.getElementById("wizard-track");
  track.style.transform = `translateX(-${(step - 1) * 100}%)`;

  updateStepIndicator();

  // Focus first interactive element in new panel
  setTimeout(() => {
    const panel = document.getElementById(`panel-${step}`);
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
    errorDiv.textContent = "Sorry, this is the earliest insurance will cover your reorder. Please text/call us if there is an extraordinary situation.";
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

// ─── Step 2: Order Details ───

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
  const max = getMaxQty();
  const key = `infQty${setNum}`;
  let newVal = state[key] + delta;
  newVal = Math.max(0, Math.min(max, newVal));
  state[key] = newVal;
  document.getElementById(`inf-qty-${setNum}`).textContent = newVal;
  updateQtyButtons();
  updateInfusionTotal();
  updateOopFooter();
}

function getMaxQty() {
  const ins = (state.patientData?.primaryInsurance || "").toLowerCase();
  // Anthem/CareCentrix = 9, everything else = 3
  if (ins.includes("anthem") || ins.includes("carecentrix")) return 9;
  return 3;
}

function updateQtyButtons() {
  const max = getMaxQty();
  // Note: individual set can go 0-max; total isn't constrained in UI per spec
  [1, 2].forEach(setNum => {
    const el = document.getElementById(`inf-qty-${setNum}`);
    if (!el) return;
    const val = state[`infQty${setNum}`];
    const row = document.getElementById(`infusion-row-${setNum}`);
    if (!row || row.classList.contains("hidden")) return;

    const btns = row.querySelectorAll(".qty-btn");
    if (btns[0]) btns[0].disabled = val <= 0;
    if (btns[1]) btns[1].disabled = val >= max;
  });
}

function updateInfusionTotal() {
  const total = state.infQty1 + (state.hasSecondSet ? state.infQty2 : 0);
  const el = document.getElementById("infusion-total-value");
  if (el) el.textContent = total;
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
  updateInfusionTotal();
}

function removeSecondSet() {
  state.hasSecondSet = false;
  state.infQty2 = 0;
  document.getElementById("infusion-row-2").classList.add("hidden");
  document.getElementById("add-set-link").classList.remove("hidden");
  document.getElementById("infusion-label-1").innerHTML = "";
  updateInfusionTotal();
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
    if (state.addressChanged) {
      const addr = document.getElementById("address-input").value.trim();
      if (!addr) {
        showFieldError("address-error", "Please enter your new address.");
        return false;
      }
      const zipMatch = addr.match(/\b(\d{5})\b/);
      if (!zipMatch) {
        showFieldError("address-error", "Address must include a valid 5-digit ZIP code.");
        return false;
      }
      state.newAddress = addr;
    }
    return true;
  }

  if (step === 4) {
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

  // Order changes (sensors, infusion)
  if (!state.sensorsOptOut && pd.servingSensors) {
    const newSensor = document.getElementById("sensor-type-select")?.value;
    if (newSensor && newSensor.toLowerCase() !== (pd.sensorsType || "").toLowerCase()) {
      hasChanges = true;
      html += reviewItem("Sensor type", pd.sensorsType || "—", newSensor);
    }
  }
  if (state.sensorsOptOut && pd.servingSensors) {
    hasChanges = true;
    html += reviewItem("Sensors", pd.sensorsType || "Ordered", "Not ordering this time");
  }

  if (!state.infusionOptOut && (pd.servingInfusionSet1 || pd.servingInfusionSet2)) {
    // Check qty changes
    const origQty1 = pd.infQty1 || 0;
    const origQty2 = pd.infQty2 || 0;
    if (state.infQty1 !== origQty1 || (state.hasSecondSet && state.infQty2 !== origQty2)) {
      hasChanges = true;
      const origDesc = `${pd.infusionSet1 || "Set 1"} (${origQty1})` + (origQty2 > 0 ? ` + ${pd.infusionSet2 || "Set 2"} (${origQty2})` : "");
      const newType1 = document.getElementById("inf-type-1")?.value || pd.infusionSet1;
      let newDesc = `${newType1} (${state.infQty1})`;
      if (state.hasSecondSet && state.infQty2 > 0) {
        const newType2 = document.getElementById("inf-type-2")?.value || "";
        newDesc += ` + ${newType2} (${state.infQty2})`;
      }
      html += reviewItem("Infusion sets", origDesc, newDesc);
    }
  }
  if (state.infusionOptOut && (pd.servingInfusionSet1 || pd.servingInfusionSet2)) {
    hasChanges = true;
    html += reviewItem("Infusion sets", "Ordered", "Not ordering this time");
  }

  // Address
  if (state.addressChanged && state.newAddress) {
    hasChanges = true;
    html += reviewItem("Address", pd.address || "—", state.newAddress);
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

function reviewItem(label, before, after) {
  return `<div class="review-item">
    <div class="review-item-label">${escHtml(label)}</div>
    <div class="review-item-before">${escHtml(before)}</div>
    <div class="review-item-arrow">→</div>
    <div class="review-item-after">${escHtml(after)}</div>
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

  if (pd.servingInfusionSet1) {
    if (state.infusionOptOut) {
      orderChanges.infusionSet1 = null;
      orderChanges.infQty1 = 0;
      orderChanges.infusionOptOut = true;
    } else {
      orderChanges.infusionSet1 = document.getElementById("inf-type-1")?.value || null;
      orderChanges.infQty1 = state.infQty1;
    }
  }

  if (state.hasSecondSet && !state.infusionOptOut) {
    orderChanges.infusionSet2 = document.getElementById("inf-type-2")?.value || null;
    orderChanges.infQty2 = state.infQty2;
  } else if (pd.servingInfusionSet2 && !state.infusionOptOut) {
    orderChanges.infusionSet2 = document.getElementById("inf-type-2")?.value || pd.infusionSet2;
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
  return "••••••••" + id.slice(-4);
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
