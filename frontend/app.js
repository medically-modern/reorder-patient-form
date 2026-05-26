// ═══════════════════════════════════════════════════════
// Reorder Patient Form — Frontend
// ═══════════════════════════════════════════════════════

const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:3001"
  : "https://reorder-patient-form-production.up.railway.app";

// ─── State ───

let patientData = null;
let orderOptions = null;
let sessionToken = null;
let selectedDecision = null;        // "confirm" | "delay" | "cancel"
let selectedDelayDate = null;
let isIndefinite = false;
let delayLessThan20Days = false;
let insuranceChanged = null;        // null | "no" | "yes"
let uploadedFiles = [];
let addressCoords = { lat: 0, lng: 0 };
let modalResolve = null;

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
    // Verify token → get session
    const authRes = await apiFetch(`/auth/verify/${token}`, { method: "GET" });
    if (!authRes.success) {
      showError(authRes.error || "Invalid or expired link.");
      return;
    }
    sessionToken = authRes.token;

    // Keep token in URL so patient can refresh or re-open the link

    // Load patient data + order options
    const [meRes, optionsRes, configRes] = await Promise.all([
      apiFetch("/api/me"),
      apiFetch("/api/order-options"),
      apiFetch("/api/config"),
    ]);

    patientData = meRes;
    orderOptions = optionsRes;

    // Load Google Places if key available
    if (configRes.googleMapsKey) {
      loadGooglePlaces(configRes.googleMapsKey);
    }

    renderForm();
  } catch (err) {
    console.error("Init error:", err);
    showError("Something went wrong loading your information. Please try your link again.");
  }
}

// ─── API helper ───

async function apiFetch(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (sessionToken) {
    headers["Authorization"] = `Bearer ${sessionToken}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    headers,
    ...opts,
  });
  const data = await res.json();
  if (!res.ok && !data.error) {
    throw new Error(`API error: ${res.status}`);
  }
  return data;
}

// ─── Show/hide helpers ───

function showError(msg) {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("error-screen").style.display = "flex";
  document.getElementById("error-message").textContent = msg;
}

function show(id) { document.getElementById(id).classList.remove("hidden"); }
function hide(id) { document.getElementById(id).classList.add("hidden"); }

// ─── Render the form ───

function renderForm() {
  document.getElementById("loading-screen").style.display = "none";
  document.getElementById("app").style.display = "block";

  // Header
  document.getElementById("patient-name").textContent = patientData.name;
  document.getElementById("header-subscription").textContent = patientData.subscription || "N/A";

  const nextOrder = patientData.nextOrder;
  document.getElementById("header-next-order").textContent = nextOrder
    ? formatDate(nextOrder)
    : "Not scheduled";

  // Pre-fill order details
  renderOrderDetails();

  // Pre-fill address
  document.getElementById("address-input").value = patientData.address || "";

  // Pre-fill insurance display
  const insType = patientData.primaryInsurance || "Unknown";
  const memberId = patientData.memberId1 || "";
  document.getElementById("ins-type-display").textContent = insType;
  document.getElementById("ins-member-display").textContent = maskMemberId(memberId);

  // Render OOP estimate card
  renderOopEstimate();
}

function renderOrderDetails() {
  // CGM (sensors)
  if (patientData.servingSensors && orderOptions?.sensorsTypes?.length > 0) {
    show("cgm-group");
    const select = document.getElementById("sensors-type");
    select.innerHTML = orderOptions.sensorsTypes
      .map(o => `<option value="${escAttr(o.label)}" ${o.label.toLowerCase() === (patientData.sensorsType || "").toLowerCase() ? "selected" : ""}>${escHtml(o.label)}</option>`)
      .join("");
  }

  // Infusion Sets
  if (patientData.servingInfusionSet1 && orderOptions?.infusionSets?.length > 0) {
    show("infusion1-group");
    const select = document.getElementById("infusion-set-1");
    select.innerHTML = orderOptions.infusionSets
      .map(o => `<option value="${escAttr(o.label)}" ${o.label.toLowerCase() === (patientData.infusionSet1 || "").toLowerCase() ? "selected" : ""}>${escHtml(o.label)}</option>`)
      .join("");
    document.getElementById("inf-qty-1").value = patientData.infQty1 || 0;
  }

  if (patientData.servingInfusionSet2 && orderOptions?.infusionSets?.length > 0) {
    show("infusion2-group");
    const select = document.getElementById("infusion-set-2");
    select.innerHTML = orderOptions.infusionSets
      .map(o => `<option value="${escAttr(o.label)}" ${o.label.toLowerCase() === (patientData.infusionSet2 || "").toLowerCase() ? "selected" : ""}>${escHtml(o.label)}</option>`)
      .join("");
    document.getElementById("inf-qty-2").value = patientData.infQty2 || 0;
  }

  // Show qty total if infusion sets are showing
  if (patientData.servingInfusionSet1 || patientData.servingInfusionSet2) {
    show("qty-total-display");
    // Set max based on insurance
    const isAnthemOrCigna = checkAnthemOrCigna();
    document.getElementById("qty-max-value").textContent = isAnthemOrCigna ? "9" : "3";
    updateQtyTotal();
  }

  // Supplies type (read-only display)
  if (patientData.servingSupplies) {
    show("supplies-group");
    const select = document.getElementById("supplies-type");
    select.innerHTML = `<option selected>${escHtml(patientData.suppliesType || "N/A")}</option>`;
  }
}

// ─── Decision handling ───

function selectDecision(value) {
  selectedDecision = value;
  isIndefinite = false;
  selectedDelayDate = null;
  delayLessThan20Days = false;

  // Update button states
  document.querySelectorAll("#decision-options .option-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.value === value);
  });

  // Show/hide sub-sections
  hide("delay-section");
  hide("cancel-warning");
  hide("indefinite-notice");
  hide("section-order");
  hide("section-address");
  hide("section-insurance");
  hide("submit-section");
  hide("skip-btn");

  if (value === "confirm") {
    // Confirm: must complete full flow
    showFullFlow();
    show("submit-section");
  } else if (value === "delay") {
    show("delay-section");
    // Don't show rest until date is selected
  } else if (value === "cancel") {
    show("cancel-warning");
    show("submit-section");
  }
}

function handleDelayDateChange() {
  const dateInput = document.getElementById("delay-date");
  const errorDiv = document.getElementById("delay-date-error");
  const dateStr = dateInput.value;

  if (!dateStr) return;

  hide("indefinite-notice");
  isIndefinite = false;

  // Validate: cannot be earlier than current order date
  const currentOrderDate = patientData.nextOrder ? new Date(patientData.nextOrder + "T00:00:00") : null;
  const selectedDate = new Date(dateStr + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (currentOrderDate && selectedDate < currentOrderDate) {
    errorDiv.textContent = "Sorry, this is the earliest insurance will cover your reorder. Please text/call us if there is an extraordinary situation where your order date needs to be pushed up.";
    show("delay-date-error");
    hide("section-order");
    hide("section-address");
    hide("section-insurance");
    hide("submit-section");
    return;
  }

  if (selectedDate < today) {
    errorDiv.textContent = "Please select a future date.";
    show("delay-date-error");
    return;
  }

  hide("delay-date-error");
  selectedDelayDate = dateStr;

  // Check if less than 20 days from today
  const diffDays = Math.ceil((selectedDate - today) / (1000 * 60 * 60 * 24));
  delayLessThan20Days = diffDays < 20;

  if (delayLessThan20Days) {
    // Less than 20 days: acts as confirmation, must complete full flow
    showModal(
      "Heads up",
      "Because this date is less than 20 days from today, this will act as confirming your order and you will not receive another confirmation text."
    ).then(() => {
      showFullFlow();
      show("submit-section");
      hide("skip-btn");
    });
  } else {
    // 20+ days: show full flow but allow skip
    showFullFlow();
    show("submit-section");
    show("skip-btn");
  }
}

function selectIndefinite() {
  isIndefinite = true;
  selectedDelayDate = null;
  delayLessThan20Days = false;
  document.getElementById("delay-date").value = "";
  hide("delay-date-error");
  show("indefinite-notice");

  // Indefinite: skip full flow, just submit
  hide("section-order");
  hide("section-address");
  hide("section-insurance");
  show("submit-section");
  hide("skip-btn");
}

function showFullFlow() {
  show("section-order");
  show("section-address");
  show("section-insurance");
}

// ─── Insurance handling ───

function selectInsuranceChange(value) {
  insuranceChanged = value;

  document.querySelectorAll("#insurance-options .option-btn").forEach(btn => {
    btn.classList.toggle("selected", btn.dataset.value === value);
  });

  if (value === "yes") {
    show("new-insurance-section");
  } else {
    hide("new-insurance-section");
  }
}

function handleNewInsuranceType() {
  const val = document.getElementById("new-insurance-type").value;
  if (val === "Other") {
    show("other-insurance-group");
  } else {
    hide("other-insurance-group");
  }
}

// ─── File upload ───

function handleCardUpload(event) {
  const files = Array.from(event.target.files);
  if (files.length + uploadedFiles.length > 2) {
    alert("You can upload a maximum of 2 images (front and back).");
    return;
  }

  files.forEach(file => {
    if (file.size > 10 * 1024 * 1024) {
      alert(`${file.name} is too large. Maximum size is 10MB.`);
      return;
    }
    uploadedFiles.push(file);
  });

  renderUploadPreviews();
  event.target.value = ""; // Reset input
}

function renderUploadPreviews() {
  const container = document.getElementById("upload-preview");
  container.innerHTML = "";

  uploadedFiles.forEach((file, idx) => {
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
      uploadedFiles.splice(idx, 1);
      renderUploadPreviews();
    };
    item.appendChild(removeBtn);
    container.appendChild(item);
  });
}

// ─── Quantity validation ───

function updateQtyTotal() {
  const qty1 = parseInt(document.getElementById("inf-qty-1")?.value) || 0;
  const qty2 = parseInt(document.getElementById("inf-qty-2")?.value) || 0;
  const total = qty1 + qty2;
  const max = checkAnthemOrCigna() ? 9 : 3;

  const display = document.getElementById("qty-total-value");
  const container = document.getElementById("qty-total-display");

  if (display) display.textContent = total;
  if (container) {
    container.classList.toggle("over-limit", total > max);
  }
}

function checkAnthemOrCigna() {
  const ins = (patientData?.primaryInsurance || "").toLowerCase();
  return ins.includes("anthem") || ins.includes("cigna");
}

// ─── Submission ───

async function handleSubmit() {
  const btn = document.getElementById("submit-btn");
  btn.disabled = true;
  btn.textContent = "Submitting...";

  try {
    // Build submission payload
    const submission = buildSubmission(false);

    // Validate
    const validationError = validateSubmission(submission);
    if (validationError) {
      alert(validationError);
      btn.disabled = false;
      btn.textContent = "Submit";
      return;
    }

    // Handle cancel confirmation
    if (submission.response === "cancel") {
      const confirmed = await showModal(
        "Are you sure?",
        "This will cancel all ongoing orders. You can text or call us if this was a mistake."
      );
      if (!confirmed) {
        btn.disabled = false;
        btn.textContent = "Submit";
        return;
      }
    }

    // Upload insurance cards if any
    if (uploadedFiles.length > 0) {
      btn.textContent = "Uploading files...";
      const formData = new FormData();
      uploadedFiles.forEach(f => formData.append("cards", f));

      const uploadRes = await fetch(`${API_BASE}/api/upload-insurance-card`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        credentials: "include",
        body: formData,
      });
      const uploadData = await uploadRes.json();
      if (uploadData.urls) {
        submission.insuranceCardUrls = uploadData.urls;
      }
    }

    // Submit
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
      btn.textContent = "Submit";
    }
  } catch (err) {
    console.error("Submit error:", err);
    alert("Something went wrong. Please try again.");
    btn.disabled = false;
    btn.textContent = "Submit";
  }
}

async function handleSkip() {
  // Skip: only write delay response + new order date
  const btn = document.getElementById("skip-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const submission = buildSubmission(true);

    const result = await apiFetch("/api/submit", {
      method: "POST",
      body: JSON.stringify(submission),
    });

    if (result.success) {
      showSuccess("Thank you! Your order has been successfully delayed. We'll reach out again before your new order date.");
    } else {
      alert(result.message || "There was an issue. Please try again.");
      btn.disabled = false;
      btn.textContent = "Skip — just update my order date";
    }
  } catch (err) {
    console.error("Skip error:", err);
    alert("Something went wrong. Please try again.");
    btn.disabled = false;
    btn.textContent = "Skip — just update my order date";
  }
}

function buildSubmission(skipDetails) {
  const submission = {
    response: selectedDecision,
    currentOrderDate: patientData.nextOrder || null,
    isAnthemOrCigna: checkAnthemOrCigna(),
  };

  // Delay fields
  if (selectedDecision === "delay") {
    submission.indefinite = isIndefinite;
    submission.newOrderDate = selectedDelayDate;
    submission.delayLessThan20Days = delayLessThan20Days;
  }

  // Skip means only write response + date, no order/address/insurance
  if (skipDetails) return submission;

  // Order changes (only if sections are visible)
  if (!document.getElementById("section-order").classList.contains("hidden")) {
    const orderChanges = {};

    if (patientData.servingSensors) {
      orderChanges.sensorsType = document.getElementById("sensors-type")?.value || null;
    }
    if (patientData.servingInfusionSet1) {
      orderChanges.infusionSet1 = document.getElementById("infusion-set-1")?.value || null;
      orderChanges.infQty1 = parseInt(document.getElementById("inf-qty-1")?.value) || 0;
    }
    if (patientData.servingInfusionSet2) {
      orderChanges.infusionSet2 = document.getElementById("infusion-set-2")?.value || null;
      orderChanges.infQty2 = parseInt(document.getElementById("inf-qty-2")?.value) || 0;
    }

    submission.orderChanges = orderChanges;
  }

  // Address
  if (!document.getElementById("section-address").classList.contains("hidden")) {
    const addressVal = document.getElementById("address-input").value.trim();
    if (addressVal && addressVal !== patientData.address) {
      submission.addressChange = {
        address: addressVal,
        lat: addressCoords.lat,
        lng: addressCoords.lng,
      };
    }
  }

  // Insurance
  if (!document.getElementById("section-insurance").classList.contains("hidden")) {
    if (insuranceChanged === "yes") {
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
  }

  return submission;
}

function validateSubmission(submission) {
  if (!submission.response) return "Please select whether to confirm, delay, or cancel your order.";

  if (submission.response === "delay" && !submission.indefinite && !submission.newOrderDate) {
    return "Please select a new order date or choose indefinitely.";
  }

  // Validate address ZIP if changed
  if (submission.addressChange) {
    const zipMatch = submission.addressChange.address.match(/\b(\d{5})\b/);
    if (!zipMatch) return "Your address must include a valid 5-digit ZIP code.";
  }

  // Validate insurance fields if changed
  if (submission.insuranceResponse === "changed") {
    if (!submission.newInsuranceType) return "Please select your new insurance type.";
    if (!submission.newMemberId) return "Please enter your new member ID.";
  }

  // Validate infusion set quantities
  if (submission.orderChanges) {
    const qty1 = submission.orderChanges.infQty1 || 0;
    const qty2 = submission.orderChanges.infQty2 || 0;
    const max = submission.isAnthemOrCigna ? 9 : 3;
    if (qty1 + qty2 > max) {
      return `Total infusion set quantity cannot exceed ${max}.`;
    }
  }

  return null;
}

// ─── Success screen ───

function showSuccess(message) {
  document.getElementById("app").style.display = "none";
  document.getElementById("success-screen").style.display = "flex";
  document.getElementById("success-message").textContent = message;
}

// ─── Modal ───

function showModal(title, message) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    document.getElementById("modal-title").textContent = title;
    document.getElementById("modal-message").textContent = message;
    show("modal-overlay");
  });
}

function confirmModal() {
  hide("modal-overlay");
  if (modalResolve) {
    modalResolve(true);
    modalResolve = null;
  }
}

function closeModal() {
  hide("modal-overlay");
  if (modalResolve) {
    modalResolve(false);
    modalResolve = null;
  }
}

// ─── Google Places Autocomplete ───

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

    input.value = place.formatted_address.replace(/(\b\d{5})-\d{4}\b/g, "$1");

    if (place.geometry?.location) {
      addressCoords.lat = place.geometry.location.lat();
      addressCoords.lng = place.geometry.location.lng();
    }
  });
}

// ─── OOP Estimate Card ───

/**
 * Derive a "serving" string compatible with the OOP estimator from
 * the reorder form's serving flags (which come from getPatientData).
 */
function deriveServing() {
  if (!patientData) return "";
  const hasCgm = patientData.servingSensors;
  const hasPump = patientData.servingSupplies || patientData.servingInfusionSet1 || patientData.servingInfusionSet2;
  if (hasCgm && hasPump) return "CGM & Pump & Supplies";
  if (hasCgm) return "CGM";
  if (hasPump) return "Pump & Supplies";
  return "";
}

function deriveInfusionSets() {
  if (!patientData) return 3;
  const qty1 = parseInt(patientData.infQty1) || 0;
  const qty2 = parseInt(patientData.infQty2) || 0;
  const total = qty1 + qty2;
  return total > 0 ? total : 3;
}

function fmt(n) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function fmtOrDash(n) {
  return n !== null ? fmt(n) : "—";
}

/**
 * Distribute deductible and coinsurance across line items proportionally
 * by their allowed amount. Purely for display — totals stay identical.
 */
function distributePerLine(lines, est) {
  var total = est.totalAllowed;

  if (!est.canCalculateCosts) {
    return lines.map(function (l) {
      return { product: l.product, allowed: l.allowed, insurancePaid: null, deductible: null, coinsurance: null, patientOwes: null };
    });
  }

  if (total === 0) {
    return lines.map(function (l) {
      return { product: l.product, allowed: l.allowed, insurancePaid: 0, deductible: 0, coinsurance: 0, patientOwes: 0 };
    });
  }

  if (est.medicaidCovers) {
    return lines.map(function (l) {
      return { product: l.product, allowed: l.allowed, insurancePaid: l.allowed, deductible: 0, coinsurance: 0, patientOwes: 0 };
    });
  }

  var oopScale = (est.patientOwesRaw || 0) > 0 ? (est.patientOwes || 0) / (est.patientOwesRaw || 1) : 1;
  var result = [];
  var runningDed = 0;
  var runningCoins = 0;

  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var proportion = l.allowed / total;
    var isLast = i === lines.length - 1;

    var lineDed;
    if (isLast) {
      lineDed = round2((est.appliedDeductible || 0) - runningDed);
    } else {
      lineDed = round2((est.appliedDeductible || 0) * proportion);
      runningDed += lineDed;
    }

    var lineCoins;
    if (isLast) {
      lineCoins = round2((est.patientCoinsurance || 0) - runningCoins);
    } else {
      lineCoins = round2((est.patientCoinsurance || 0) * proportion);
      runningCoins += lineCoins;
    }

    var linePatientOwes = round2((lineDed + lineCoins) * oopScale);
    var lineInsPaid = round2(l.allowed - linePatientOwes);

    result.push({
      product: l.product,
      allowed: l.allowed,
      insurancePaid: Math.max(0, lineInsPaid),
      deductible: lineDed,
      coinsurance: lineCoins,
      patientOwes: linePatientOwes,
    });
  }

  return result;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

var FIELD_WARNINGS = {
  deductible: "Deductible remaining is missing — cannot calculate deductible portion",
  coinsurance: "Coinsurance % is missing — cannot calculate co-ins/copay portion",
  oopMax: "OOP max remaining is missing — patient total is not capped",
};

function renderOopEstimate() {
  var container = document.getElementById("oop-estimate");
  if (!container) return;

  if (!patientData || !patientData.primaryInsurance) {
    container.innerHTML = "";
    return;
  }

  // CareCentrix check
  var isCarecentrix = (patientData.referralSource || "").toLowerCase().includes("carecentrix");
  if (isCarecentrix) {
    container.innerHTML =
      '<div class="oop-card">' +
        '<p class="oop-label">OOP Estimate (Per Fill)</p>' +
        '<p class="oop-carecentrix">Carecentrix patients have to contact carecentrix directly for their OOP costs.</p>' +
      '</div>';
    return;
  }

  var serving = deriveServing();
  var infusionSets = deriveInfusionSets();

  var result = estimateOop({
    primaryInsurance: patientData.primaryInsurance,
    secondaryInsurance: patientData.secondaryInsurance || "",
    serving: serving,
    infusionSets: infusionSets,
    deductibleRemaining: patientData.deductibleRemaining || "",
    stediCoinsurance: patientData.stediCoinsurance || "",
    oopMaxRemaining: patientData.oopMaxRemaining || "",
  });

  if (!result || !result.ok) {
    if (!serving) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML =
      '<div class="oop-card">' +
        '<p class="oop-label">OOP Estimate (Per Fill)</p>' +
        '<p class="oop-unable">' + escHtml(result && result.reason ? result.reason : "Unable to estimate") + '</p>' +
      '</div>';
    return;
  }

  var est = result;
  var displayLines = distributePerLine(est.lines, est);
  var hasMissing = est.missingFields.length > 0 && !est.medicaidCovers;
  var costsUnknown = !est.canCalculateCosts && !est.medicaidCovers;

  // Color classes
  var patientOwesClass = est.patientOwes === null ? "muted"
    : est.patientOwes === 0 ? "green"
    : est.patientOwes > 500 ? "red" : "blue";

  var headerOwesClass = costsUnknown ? "amber" : hasMissing ? "amber" : patientOwesClass;

  // Build HTML
  var html = '<div class="oop-card">';

  // Header summary
  html += '<div class="oop-header">';
  html += '<p class="oop-label">OOP Estimate (Per Fill)</p>';
  html += '<div class="oop-summary">';
  html += '<div class="oop-summary-line">';
  html += '<span>Allowed <strong>' + fmt(est.totalAllowed) + '</strong></span>';
  html += '<span class="oop-sep">&minus;</span>';
  html += '<span>Ins. paid <strong class="oop-' + (est.insurancePays !== null ? 'green' : 'muted') + '">' + fmtOrDash(est.insurancePays) + '</strong></span>';
  html += '<span class="oop-sep">=</span>';
  html += '<span class="oop-total">Patient owes <strong class="oop-' + headerOwesClass + '">' + fmtOrDash(est.patientOwes) + (hasMissing && est.patientOwes !== null ? ' *' : '') + '</strong></span>';
  html += '</div>';

  // Sub-detail line
  if (est.canCalculateCosts && !est.medicaidCovers) {
    var oopMaxHit = est.patientOwes !== null && est.patientOwesRaw !== null && est.patientOwes < est.patientOwesRaw;
    var displayCoins = oopMaxHit
      ? Math.max(0, est.patientOwes - est.appliedDeductible)
      : est.patientCoinsurance;
    html += '<p class="oop-subdetail">';
    html += 'Ded. ' + fmt(est.appliedDeductible) + ' · Co-ins/Copay ' + fmt(displayCoins);
    if (oopMaxHit) html += ' <span class="oop-amber oop-bold">OOP Max Hit</span>';
    html += '</p>';
  }
  if (est.medicaidCovers) {
    html += '<p class="oop-subdetail oop-green">' + escHtml(est.medicaidNote) + '</p>';
  }

  html += '</div></div>';

  // Line items table
  html += '<div class="oop-table-wrap"><table class="oop-table">';
  html += '<thead><tr>';
  html += '<th>Item</th><th class="r">Allowed</th><th class="r">Ins. Paid</th>';
  html += '<th class="r">Deductible</th><th class="r">Co-ins / Copay</th><th class="r">Patient Owes</th>';
  html += '</tr></thead><tbody>';

  for (var i = 0; i < displayLines.length; i++) {
    var line = displayLines[i];
    html += '<tr>';
    html += '<td class="oop-product">' + escHtml(line.product) + '</td>';
    html += '<td class="r">' + fmt(line.allowed) + '</td>';
    if (line.insurancePaid !== null) {
      html += '<td class="r oop-green">' + fmt(line.insurancePaid) + '</td>';
      html += '<td class="r">' + fmt(line.deductible) + '</td>';
      html += '<td class="r">' + fmt(line.coinsurance) + '</td>';
      html += '<td class="r oop-' + (hasMissing ? 'amber' : patientOwesClass) + ' oop-bold">' + fmt(line.patientOwes) + '</td>';
    } else {
      html += '<td class="r muted">—</td><td class="r muted">—</td><td class="r muted">—</td><td class="r muted">—</td>';
    }
    html += '</tr>';
  }

  html += '</tbody>';

  // Totals row
  html += '<tfoot><tr class="oop-totals">';
  html += '<td class="oop-bold">Total</td>';
  html += '<td class="r oop-bold">' + fmt(est.totalAllowed) + '</td>';
  if (est.insurancePays !== null) {
    html += '<td class="r oop-green oop-bold">' + fmt(est.insurancePays) + '</td>';
    html += '<td class="r oop-bold">' + fmt(est.appliedDeductible) + '</td>';
    html += '<td class="r oop-bold">' + fmt(est.patientCoinsurance) + '</td>';
    html += '<td class="r oop-' + (hasMissing ? 'amber' : patientOwesClass) + ' oop-bold">' + fmt(est.patientOwes) + '</td>';
  } else {
    html += '<td class="r muted oop-bold">—</td><td class="r muted oop-bold">—</td><td class="r muted oop-bold">—</td><td class="r oop-amber oop-bold">—</td>';
  }
  html += '</tr></tfoot></table></div>';

  // Missing field warnings
  if (hasMissing) {
    html += '<div class="oop-warnings">';
    for (var j = 0; j < est.missingFields.length; j++) {
      var field = est.missingFields[j];
      html += '<p class="oop-warning">⚠ ' + escHtml(FIELD_WARNINGS[field] || field) + '</p>';
    }
    if (costsUnknown) {
      html += '<p class="oop-warning oop-bold">Run Stedi eligibility to get accurate cost estimates</p>';
    }
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

// ─── Utility functions ───

function formatDate(dateStr) {
  if (!dateStr) return "N/A";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function maskMemberId(id) {
  if (!id || id.length < 4) return id || "N/A";
  return "********" + id.slice(-4);
}

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
