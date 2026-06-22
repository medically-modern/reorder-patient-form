const {
  SUBSCRIPTION_BOARD_ID,
  COLUMNS,
  ORDER_RESPONSE_INDEX,
  INSURANCE_RESPONSE_INDEX,
} = require("./config");
const { enqueueWriteAndWait, startWorker, startReorderWorker, startSmsWorker, startSmsVerifyWorker } = require("./queue");
const { notifyMondayError } = require("./notify");
const { estimateOop } = require("./oopEstimator");

const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
const API_URL = "https://api.monday.com/v2";

let _queueEnabled = false;

// ─── Input validation ───

function validateNumericId(id, label = "ID") {
  const str = String(id);
  if (!/^\d+$/.test(str)) throw new Error(`Invalid ${label}: must be numeric, got "${str}"`);
  return str;
}

function validateColumnId(id) {
  const str = String(id);
  if (!/^[a-z0-9_]+$/.test(str)) throw new Error(`Invalid column ID: got "${str}"`);
  return str;
}

// ─── Monday GraphQL client with retry ───

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

async function mondayQuery(query, variables = {}, _attempt = 1) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: MONDAY_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 429) {
    if (_attempt > MAX_RETRIES) throw new Error("Monday API rate limit exceeded after retries");
    const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
    const delay = retryAfter > 0 ? retryAfter * 1000 : BASE_DELAY_MS * Math.pow(2, _attempt - 1) + Math.random() * 500;
    console.warn(`[monday] Rate limited (429), retrying in ${Math.round(delay)}ms (attempt ${_attempt}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, delay));
    return mondayQuery(query, variables, _attempt + 1);
  }

  if (res.status >= 500 && _attempt <= MAX_RETRIES) {
    const delay = BASE_DELAY_MS * Math.pow(2, _attempt - 1);
    console.warn(`[monday] Server error ${res.status}, retrying in ${delay}ms (attempt ${_attempt}/${MAX_RETRIES})`);
    await new Promise((r) => setTimeout(r, delay));
    return mondayQuery(query, variables, _attempt + 1);
  }

  const data = await res.json();

  if (data.errors) {
    const rateLimitError = data.errors.find((e) =>
      e.message?.toLowerCase().includes("rate limit") || e.extensions?.code === "RATE_LIMITED"
    );
    if (rateLimitError && _attempt <= MAX_RETRIES) {
      const delay = BASE_DELAY_MS * Math.pow(2, _attempt - 1) + Math.random() * 500;
      console.warn(`[monday] Rate limit in response, retrying in ${Math.round(delay)}ms`);
      await new Promise((r) => setTimeout(r, delay));
      return mondayQuery(query, variables, _attempt + 1);
    }
    throw new Error(`Monday API error: ${JSON.stringify(data.errors)}`);
  }

  return data.data;
}

// ─── Queued write helper ───

async function mondayWrite(query, variables, label = "write") {
  if (_queueEnabled) {
    return enqueueWriteAndWait(query, variables, label);
  }
  return mondayQuery(query, variables);
}

// ─── Per-column write helpers ───

const WRITE_MUTATION = `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
  change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
}`;

async function writeText(itemId, columnId, text) {
  await mondayWrite(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId, value: JSON.stringify(text),
  }, `text:${columnId}`);
}

async function writeStatusIndex(itemId, columnId, index) {
  await mondayWrite(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId, value: JSON.stringify({ index }),
  }, `status:${columnId}`);
}

async function writeLongText(itemId, columnId, text) {
  await mondayWrite(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId,
    value: JSON.stringify({ text }),
  }, `longtext:${columnId}`);
}

async function writeDate(itemId, columnId, dateStr) {
  // dateStr should be "YYYY-MM-DD" or null to clear
  const value = dateStr ? JSON.stringify({ date: dateStr }) : JSON.stringify({});
  await mondayWrite(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId, value,
  }, `date:${columnId}`);
}

async function clearDate(itemId, columnId) {
  await mondayWrite(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId, value: JSON.stringify({}),
  }, `clear-date:${columnId}`);
}

async function writeNumber(itemId, columnId, num) {
  await mondayWrite(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId,
    value: JSON.stringify(String(parseFloat(num) || 0)),
  }, `number:${columnId}`);
}

async function writeLocation(itemId, columnId, address, lat = 0, lng = 0) {
  await mondayWrite(WRITE_MUTATION, {
    boardId: SUBSCRIPTION_BOARD_ID, itemId, columnId,
    value: JSON.stringify({ address, lat, lng }),
  }, `location:${columnId}`);
}

// ─── Status index resolution ───

let _statusIndexCache = null;

async function getStatusIndexMap() {
  if (_statusIndexCache) return _statusIndexCache;
  const data = await mondayQuery(`{ boards(ids: ${validateNumericId(SUBSCRIPTION_BOARD_ID)}) { columns { id type settings_str } } }`);
  const map = {};
  for (const col of data.boards[0].columns) {
    if (col.type !== "status") continue;
    try {
      const settings = JSON.parse(col.settings_str);
      if (settings.labels) {
        map[col.id] = {};
        for (const [idx, label] of Object.entries(settings.labels)) {
          if (!label) continue;
          const normalized = label.replace(/[\s   ]+/g, " ").trim().toLowerCase();
          map[col.id][normalized] = parseInt(idx, 10);
        }
      }
    } catch {}
  }
  _statusIndexCache = map;
  return map;
}

function resolveStatusIndex(columnId, portalValue, indexMap) {
  if (!indexMap[columnId]) return null;
  const normalized = portalValue.replace(/[\s   ]+/g, " ").trim().toLowerCase();
  const idx = indexMap[columnId][normalized];
  return idx !== undefined ? idx : null;
}

// ─── Find patient by UID ───

async function findPatientByUid(uid) {
  const safeBoard = validateNumericId(SUBSCRIPTION_BOARD_ID, "board ID");
  const safeCol = validateColumnId(COLUMNS.PATIENT_UID);

  const data = await mondayQuery(`{
    items_page_by_column_values(
      board_id: ${safeBoard},
      limit: 1,
      columns: [{column_id: "${safeCol}", column_values: ["${uid.replace(/"/g, "")}"]}]
    ) {
      items {
        id name group { id title }
        column_values { id type text value }
      }
    }
  }`);

  return data.items_page_by_column_values?.items?.[0] || null;
}

// ─── Find patient by Monday row id ───
// The reorder flow routes writes by itemId (the exact order row), not UID,
// because a patient can have multiple rows sharing one UID.
async function getPatientItemById(itemId) {
  const safeId = validateNumericId(itemId, "item ID");

  const data = await mondayQuery(`{
    items(ids: [${safeId}]) {
      id name group { id title }
      column_values { id type text value }
    }
  }`);

  return data.items?.[0] || null;
}

// ─── Find patient by phone ───

async function findPatientByPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  const safeBoard = validateNumericId(SUBSCRIPTION_BOARD_ID, "board ID");
  const safePhoneCol = validateColumnId(COLUMNS.PHONE);

  const data = await mondayQuery(`{
    items_page_by_column_values(
      board_id: ${safeBoard},
      limit: 10,
      columns: [{column_id: "${safePhoneCol}", column_values: ["${digits}"]}]
    ) {
      items {
        id name group { id title }
        column_values(ids: ["${safePhoneCol}", "${validateColumnId(COLUMNS.PATIENT_UID)}"]) {
          id text value
        }
      }
    }
  }`);

  const items = data.items_page_by_column_values?.items || [];
  if (items.length === 0) return null;

  const match = items.find((item) => {
    const uidCol = item.column_values.find((c) => c.id === COLUMNS.PATIENT_UID);
    return uidCol?.text;
  }) || items[0];

  const uidCol = match.column_values.find((c) => c.id === COLUMNS.PATIENT_UID);
  const phoneCol = match.column_values.find((c) => c.id === COLUMNS.PHONE);

  return {
    itemId: match.id,
    name: match.name,
    uid: uidCol?.text || null,
    phone: phoneCol?.text || digits,
    group: match.group,
  };
}

// ─── Get full patient data for reorder form ───

async function getPatientData(itemId) {
  const item = await getPatientItemById(itemId);
  if (!item) return null;

  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };

  const colValue = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    try { return c?.value ? JSON.parse(c.value) : null; } catch { return null; }
  };

  // Determine what's actively being served
  const subscription = col(COLUMNS.SUBSCRIPTION);
  const sensorsType = col(COLUMNS.SENSORS_TYPE);
  const suppliesType = col(COLUMNS.SUPPLIES_TYPE);
  const infusionSet1 = col(COLUMNS.INFUSION_SET_1);
  const infusionSet2 = col(COLUMNS.INFUSION_SET_2);

  const isServing = (val) => val && val !== "Not Serving" && val.trim() !== "";

  return {
    itemId: item.id,
    name: item.name,

    // Subscription core
    status: col(COLUMNS.STATUS),
    activeStatus: col(COLUMNS.ACTIVE_STATUS),
    subscription,
    orderType: col(COLUMNS.ORDER_TYPE),
    nextOrder: col(COLUMNS.NEXT_ORDER),
    daysToOrder: col(COLUMNS.DAYS_TO_ORDER),

    // Demographics
    phone: col(COLUMNS.PHONE),
    email: col(COLUMNS.EMAIL),
    address: col(COLUMNS.ADDRESS),

    // Insurance
    primaryInsurance: col(COLUMNS.PRIMARY_INS),
    memberId1: col(COLUMNS.MEMBER_ID_1),
    secondaryInsurance: col(COLUMNS.SECONDARY_INS),
    memberId2: col(COLUMNS.MEMBER_ID_2),

    // Order details — only include what's actively being served
    servingSensors: isServing(sensorsType),
    servingSupplies: isServing(suppliesType),
    servingInfusionSet1: isServing(infusionSet1),
    servingInfusionSet2: isServing(infusionSet2),

    sensorsType: isServing(sensorsType) ? sensorsType : null,
    cgmQty: isServing(sensorsType) ? col(COLUMNS.CGM_QTY) : null,
    suppliesType: isServing(suppliesType) ? suppliesType : null,
    cartridgeQty: isServing(suppliesType) ? col(COLUMNS.CARTRIDGE_QTY) : null,
    infusionSet1: isServing(infusionSet1) ? infusionSet1 : null,
    infQty1: isServing(infusionSet1) ? col(COLUMNS.INF_QTY_1) : null,
    infusionSet2: isServing(infusionSet2) ? infusionSet2 : null,
    infQty2: isServing(infusionSet2) ? col(COLUMNS.INF_QTY_2) : null,

    // Benefits / Stedi (for OOP estimator)
    deductibleRemaining: col(COLUMNS.DEDUCTIBLE_REMAINING),
    stediCoinsurance: col(COLUMNS.STEDI_COINSURANCE),
    oopMaxRemaining: col(COLUMNS.OOP_MAX_REMAINING),

    // Previous reorder response (if any)
    previousOrderResponse: col(COLUMNS.PATIENT_ORDER_RESPONSE),
    previousResponseTimestamp: col(COLUMNS.PATIENT_RESPONSE_TIMESTAMP),
  };
}

// ═══════════════════════════════════════════════════════
// REORDER SUBMISSION — THE CORE WRITEBACK LOGIC
// ═══════════════════════════════════════════════════════

/**
 * Process a reorder form submission.
 *
 * @param {string} uid - Patient UID
 * @param {Object} submission - The form data:
 *   - response: "confirm" | "delay" | "cancel"
 *   - newOrderDate: "YYYY-MM-DD" | null (for delay)
 *   - indefinite: boolean (for delay)
 *   - orderChanges: { sensorsType, suppliesType, infusionSet1, infQty1, infusionSet2, infQty2 }
 *   - addressChange: { address, lat, lng } | null
 *   - insuranceResponse: "confirmed" | "changed"
 *   - newInsuranceType: string | null
 *   - newMemberId: string | null
 *   - insuranceCardUrls: string[] | null
 * @returns {Promise<{success: boolean, message: string, failures: string[]}>}
 */
async function processReorderSubmission(itemIdArg, submission) {
  const item = await getPatientItemById(itemIdArg);
  if (!item) throw new Error("Patient not found");
  const itemId = validateNumericId(item.id, "item ID");

  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };

  const indexMap = await getStatusIndexMap();
  const tasks = [];
  const failures = [];
  const changeSummaryParts = [];
  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }) + " ET";

  // Normalize for case-insensitive, whitespace-insensitive comparison of status labels
  const norm = (s) => (s || "").replace(/[\s ]+/g, " ").trim().toLowerCase();

  // ─── Always write: response + timestamp ───

  const responseMap = {
    confirm: ORDER_RESPONSE_INDEX.CONFIRM,
    delay:   ORDER_RESPONSE_INDEX.DELAY,
    cancel:  ORDER_RESPONSE_INDEX.CANCEL,
  };

  const responseIndex = responseMap[submission.response];

  // help-only messages skip order response / timestamp writes
  if (submission.response !== "help-only") {
    if (responseIndex === undefined) throw new Error(`Invalid response: ${submission.response}`);

    tasks.push({
      label: "Patient Order Response",
      fn: () => writeStatusIndex(itemId, COLUMNS.PATIENT_ORDER_RESPONSE, responseIndex),
    });

    tasks.push({
      label: "Patient Response Timestamp",
      fn: () => writeText(itemId, COLUMNS.PATIENT_RESPONSE_TIMESTAMP, now),
    });
  }

  // ─── Handle response-specific logic ───

  if (submission.response === "cancel") {
    // Cancel: clear order date
    const previousDate = col(COLUMNS.NEXT_ORDER);
    tasks.push({
      label: "Clear Order Date",
      fn: () => clearDate(itemId, COLUMNS.NEXT_ORDER),
    });
    if (previousDate) {
      changeSummaryParts.push(`Deleted order date of ${previousDate}.`);
    }
  }

  if (submission.response === "delay") {
    if (submission.indefinite) {
      // Indefinite delay: clear order date
      tasks.push({
        label: "Clear Order Date (Indefinite)",
        fn: () => clearDate(itemId, COLUMNS.NEXT_ORDER),
      });
      changeSummaryParts.push("Patient selected indefinite delay — order date cleared.");
    } else if (submission.newOrderDate) {
      // Specific date delay: overwrite order date
      const previousDate = col(COLUMNS.NEXT_ORDER);
      tasks.push({
        label: "Update Order Date",
        fn: () => writeDate(itemId, COLUMNS.NEXT_ORDER, submission.newOrderDate),
      });
      changeSummaryParts.push(`Order date changed from ${previousDate || "none"} to ${submission.newOrderDate}.`);
    }
  }

  // ─── Order detail changes (confirm, delay with <20 days, or delay with optional completion) ───

  if (submission.orderChanges) {
    const oc = submission.orderChanges;

    // CGM Qty — always 3 (no skip option)
    tasks.push({ label: "CGM Qty", fn: () => writeNumber(itemId, COLUMNS.CGM_QTY, 3) });

    // Sensors type
    if (oc.sensorsType !== undefined && oc.sensorsType !== null) {
      const currentVal = col(COLUMNS.SENSORS_TYPE);
      if (norm(oc.sensorsType) !== norm(currentVal)) {
        const idx = resolveStatusIndex(COLUMNS.SENSORS_TYPE, oc.sensorsType, indexMap);
        if (idx !== null) {
          tasks.push({ label: "Sensors Type", fn: () => writeStatusIndex(itemId, COLUMNS.SENSORS_TYPE, idx) });
          changeSummaryParts.push(`CGM type changed from ${currentVal} to ${oc.sensorsType}.`);
        } else {
          failures.push(`Sensors Type: "${oc.sensorsType}" is not a valid option`);
        }
      }
    }

    // Cartridge Qty — user-selected (1–3), only if patient has supplies
    if (oc.cartridgeQty !== undefined && oc.cartridgeQty !== null) {
      const cartQty = parseInt(oc.cartridgeQty, 10);
      const qty = (!isNaN(cartQty) && cartQty >= 1 && cartQty <= 3) ? cartQty : 3;
      const currentVal = col(COLUMNS.CARTRIDGE_QTY);
      tasks.push({ label: "Cartridge Qty", fn: () => writeNumber(itemId, COLUMNS.CARTRIDGE_QTY, qty) });
      if (String(qty) !== currentVal) {
        changeSummaryParts.push(`Cartridge quantity changed from ${currentVal || "3"} to ${qty}.`);
      }
    }

    // Supplies type (cartridges)
    if (oc.suppliesType !== undefined && oc.suppliesType !== null) {
      const currentVal = col(COLUMNS.SUPPLIES_TYPE);
      if (norm(oc.suppliesType) !== norm(currentVal)) {
        const idx = resolveStatusIndex(COLUMNS.SUPPLIES_TYPE, oc.suppliesType, indexMap);
        if (idx !== null) {
          tasks.push({ label: "Supplies Type", fn: () => writeStatusIndex(itemId, COLUMNS.SUPPLIES_TYPE, idx) });
          changeSummaryParts.push(`Pump type changed from ${currentVal} to ${oc.suppliesType}.`);
        } else {
          failures.push(`Supplies Type: "${oc.suppliesType}" is not a valid option`);
        }
      }
    }

    // Infusion Set 1
    if (oc.infusionSet1 !== undefined && oc.infusionSet1 !== null) {
      const currentVal = col(COLUMNS.INFUSION_SET_1);
      if (norm(oc.infusionSet1) !== norm(currentVal)) {
        const idx = resolveStatusIndex(COLUMNS.INFUSION_SET_1, oc.infusionSet1, indexMap);
        if (idx !== null) {
          tasks.push({ label: "Infusion Set 1", fn: () => writeStatusIndex(itemId, COLUMNS.INFUSION_SET_1, idx) });
          changeSummaryParts.push(`Infusion set 1 changed from ${currentVal} to ${oc.infusionSet1}.`);
        } else {
          failures.push(`Infusion Set 1: "${oc.infusionSet1}" is not a valid option`);
        }
      }
    }

    // Infusion Qty 1
    if (oc.infQty1 !== undefined && oc.infQty1 !== null) {
      const currentVal = col(COLUMNS.INF_QTY_1);
      if (String(oc.infQty1) !== currentVal) {
        tasks.push({ label: "Infusion Qty 1", fn: () => writeNumber(itemId, COLUMNS.INF_QTY_1, oc.infQty1) });
        changeSummaryParts.push(`Infusion set 1 quantity changed from ${currentVal || "0"} to ${oc.infQty1}.`);
      }
    }

    // Infusion Set 2
    if (oc.infusionSet2 !== undefined && oc.infusionSet2 !== null) {
      const currentVal = col(COLUMNS.INFUSION_SET_2);
      if (norm(oc.infusionSet2) !== norm(currentVal)) {
        const idx = resolveStatusIndex(COLUMNS.INFUSION_SET_2, oc.infusionSet2, indexMap);
        if (idx !== null) {
          tasks.push({ label: "Infusion Set 2", fn: () => writeStatusIndex(itemId, COLUMNS.INFUSION_SET_2, idx) });
          changeSummaryParts.push(`Infusion set 2 changed from ${currentVal} to ${oc.infusionSet2}.`);
        } else {
          failures.push(`Infusion Set 2: "${oc.infusionSet2}" is not a valid option`);
        }
      }
    }

    // Infusion Qty 2
    if (oc.infQty2 !== undefined && oc.infQty2 !== null) {
      const currentVal = col(COLUMNS.INF_QTY_2);
      if (String(oc.infQty2) !== currentVal) {
        tasks.push({ label: "Infusion Qty 2", fn: () => writeNumber(itemId, COLUMNS.INF_QTY_2, oc.infQty2) });
        changeSummaryParts.push(`Infusion set 2 quantity changed from ${currentVal || "0"} to ${oc.infQty2}.`);
      }
    }
  }

  // ─── Address changes ───

  if (submission.addressChange) {
    const currentAddr = col(COLUMNS.ADDRESS);
    const newAddr = submission.addressChange.address;
    if (newAddr && newAddr !== currentAddr) {
      tasks.push({
        label: "Address",
        fn: () => writeLocation(
          itemId, COLUMNS.ADDRESS, newAddr,
          submission.addressChange.lat || 0,
          submission.addressChange.lng || 0
        ),
      });
      changeSummaryParts.push(`Address changed from ${currentAddr || "none"} to ${newAddr}.`);
    }
  }

  // ─── Insurance response ───

  if (submission.insuranceResponse) {
    const insResponseIndex = submission.insuranceResponse === "changed"
      ? INSURANCE_RESPONSE_INDEX.CHANGED
      : INSURANCE_RESPONSE_INDEX.CONFIRMED;

    tasks.push({
      label: "Patient Insurance Response",
      fn: () => writeStatusIndex(itemId, COLUMNS.PATIENT_INSURANCE_RESPONSE, insResponseIndex),
    });

    if (submission.insuranceResponse === "changed") {
      if (submission.newInsuranceType) {
        tasks.push({
          label: "New Insurance Type",
          fn: () => writeText(itemId, COLUMNS.NEW_INSURANCE_TYPE, submission.newInsuranceType),
        });
      }
      if (submission.newMemberId) {
        tasks.push({
          label: "New Member ID",
          fn: () => writeText(itemId, COLUMNS.NEW_MEMBER_ID, submission.newMemberId),
        });
      }

      const currentIns = col(COLUMNS.PRIMARY_INS);
      const currentMemberId = col(COLUMNS.MEMBER_ID_1);
      const maskedMemberId = currentMemberId ? "****" + currentMemberId.slice(-4) : "N/A";
      changeSummaryParts.push(
        `Insurance changed from ${currentIns || "unknown"} ending in ${maskedMemberId} to ${submission.newInsuranceType || "unknown"}, new member ID provided.`
      );
    }
  }

  // ─── Write change summary (APPEND to existing) ───

  // Always log a summary entry, even if no specific changes were made
  if (changeSummaryParts.length === 0) {
    const responseLabels = { confirm: "Confirmed order — no changes.", delay: "Delayed order — no detail changes.", cancel: "Cancelled order." };
    changeSummaryParts.push(responseLabels[submission.response] || `Response: ${submission.response}`);
  }

  {
    const existingSummary = col(COLUMNS.PATIENT_CHANGE_SUMMARY);
    const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "short", timeStyle: "short" });
    const header = `[${timestamp}] Patient ${submission.response.toUpperCase()}:`;
    const newEntry = `${header}\n${changeSummaryParts.join("\n")}`;
    const fullSummary = existingSummary
      ? `${existingSummary}\n\n${newEntry}`
      : newEntry;
    tasks.push({
      label: "Patient Change Summary",
      fn: () => writeLongText(itemId, COLUMNS.PATIENT_CHANGE_SUMMARY, fullSummary),
    });
  }

  // Help messages are handled by the dedicated /api/help-message endpoint

  // ─── Execute all writes in parallel ───

  console.log(`[monday] Processing reorder submission for UID ${uid}: ${tasks.length} writes, response=${submission.response}`);

  const results = await Promise.all(
    tasks.map(async (task) => {
      try {
        await task.fn();
        return null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[monday] Write failed for ${task.label}: ${msg}`);
        return `${task.label}: ${msg}`;
      }
    })
  );

  for (const r of results) {
    if (r) failures.push(r);
  }

  const saved = tasks.length - results.filter(Boolean).length;

  if (failures.length > 0) {
    console.error(`[monday] Partial submission for item ${itemId}: ${saved}/${tasks.length} saved, failures:`, failures);
    await notifyMondayError(`Partial write: ${saved}/${tasks.length} saved\nFailures:\n${failures.join("\n")}`, String(itemId));
    return { success: false, partial: true, saved, failures };
  }

  console.log(`[monday] Reorder submission complete for item ${itemId}: all ${saved} writes succeeded`);
  return { success: true, saved, failures: [] };
}

// ─── Upload file to Monday file column ───

async function uploadFileToMonday(itemId, columnId, fileBuffer, fileName) {
  // Monday requires multipart form POST to /v2/file
  const boundary = "----MondayFileUpload" + Date.now();
  const query = `mutation ($file: File!) { add_file_to_column (item_id: ${itemId}, column_id: "${validateColumnId(columnId)}", file: $file) { id } }`;

  // Build multipart body manually (no form-data dependency needed)
  const parts = [];

  // Query part
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="query"\r\n\r\n`);
  parts.push(`${query}\r\n`);

  // Map part (tells Monday which variable maps to which file part)
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="map"\r\n\r\n`);
  parts.push(`{"image":"variables.file"}\r\n`);

  // File part
  parts.push(`--${boundary}\r\n`);
  parts.push(`Content-Disposition: form-data; name="image"; filename="${fileName}"\r\n`);
  parts.push(`Content-Type: application/octet-stream\r\n\r\n`);

  const closingBoundary = Buffer.from(`\r\n--${boundary}--\r\n`);

  // Combine text parts + file buffer + closing boundary
  const textParts = Buffer.from(parts.join(""));
  const body = Buffer.concat([textParts, fileBuffer, closingBoundary]);

  try {
    console.log(`[monday] Uploading file "${fileName}" to item ${itemId}, column ${columnId} (${fileBuffer.length} bytes)`);

    const res = await fetch(`${API_URL}/file`, {
      method: "POST",
      headers: {
        Authorization: MONDAY_TOKEN,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const data = await res.json();

    if (data.errors) {
      console.error(`[monday] File upload error:`, data.errors);
      return { success: false, error: data.errors[0]?.message || "Upload failed" };
    }

    console.log(`[monday] File "${fileName}" uploaded successfully to item ${itemId}`);
    return { success: true, fileId: data.data?.add_file_to_column?.id };
  } catch (err) {
    console.error(`[monday] File upload failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── Lookup token in Monday (fallback when Redis misses) ───

async function lookupTokenInMonday(token) {
  const safeBoard = validateNumericId(SUBSCRIPTION_BOARD_ID, "board ID");
  const safeCol = validateColumnId(COLUMNS.REORDER_TOKEN);

  const data = await mondayQuery(`{
    items_page_by_column_values(
      board_id: ${safeBoard},
      limit: 1,
      columns: [{column_id: "${safeCol}", column_values: ["${token.replace(/"/g, "")}"]}]
    ) {
      items {
        id name
        column_values(ids: ["${validateColumnId(COLUMNS.PATIENT_UID)}"]) { id text }
      }
    }
  }`);

  const item = data.items_page_by_column_values?.items?.[0];
  if (!item) return null;

  const uid = item.column_values?.find(c => c.id === COLUMNS.PATIENT_UID)?.text;
  if (!uid) return null;

  console.log(`[monday] Token found in Monday for UID ${uid} (item ${item.id}, fallback from Redis miss)`);
  return { uid, itemId: String(item.id) };
}

// ─── Generate & store reorder token in Monday ───

async function writeHelpMessage(itemIdArg, helpMessage, helpChip) {
  const item = await getPatientItemById(itemIdArg);
  if (!item) throw new Error("Patient not found");
  const itemId = validateNumericId(item.id, "item ID");

  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "short",
    timeStyle: "short",
  });

  const body = helpChip
    ? `[${helpChip}]\n${helpMessage}`
    : helpMessage;

  const newEntry = `[${timestamp} ET]\n${body}`;

  // Read existing help messages and append
  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };
  const existing = col(COLUMNS.PATIENT_HELP_MSG);
  const helpText = existing
    ? `${existing}\n\n${newEntry}`
    : newEntry;

  await writeLongText(itemId, COLUMNS.PATIENT_HELP_MSG, helpText);
  console.log(`[monday] Help message appended for item ${itemId} at ${timestamp}`);
}

async function storeTokenInMonday(itemIdArg, token, link) {
  const item = await getPatientItemById(itemIdArg);
  if (!item) throw new Error("Patient not found");
  const itemId = validateNumericId(item.id, "item ID");

  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };

  // Calculate OOP estimate using the same logic as the frontend
  const writes = [
    writeText(itemId, COLUMNS.REORDER_TOKEN, token),
    writeText(itemId, COLUMNS.REORDER_LINK, link),
  ];

  try {
    const subscription = col(COLUMNS.SUBSCRIPTION);
    const primaryIns = col(COLUMNS.PRIMARY_INS);

    const isServing = (val) => val && val !== "Not Serving" && val.trim() !== "";
    const hasCgm = isServing(col(COLUMNS.SENSORS_TYPE));
    const hasPump = isServing(col(COLUMNS.SUPPLIES_TYPE)) || isServing(col(COLUMNS.INFUSION_SET_1));
    let serving = "";
    if (hasCgm && hasPump) serving = "CGM & Pump & Supplies";
    else if (hasCgm) serving = "CGM";
    else if (hasPump) serving = "Pump & Supplies";

    const infQty1 = parseInt(col(COLUMNS.INF_QTY_1), 10) || 0;
    const infQty2 = parseInt(col(COLUMNS.INF_QTY_2), 10) || 0;
    const infusionSets = (infQty1 + infQty2) || 3;

    const est = estimateOop({
      primaryInsurance: primaryIns,
      secondaryInsurance: col(COLUMNS.SECONDARY_INS) || "",
      serving,
      infusionSets,
      deductibleRemaining: col(COLUMNS.DEDUCTIBLE_REMAINING) || "",
      stediCoinsurance: col(COLUMNS.STEDI_COINSURANCE) || "",
      oopMaxRemaining: col(COLUMNS.OOP_MAX_REMAINING) || "",
    });

    let oopText;
    if (est.ok && est.canCalculateCosts) {
      oopText = `$${est.patientOwes.toFixed(2)}`;
    } else if (est.ok && est.medicaidCovers) {
      oopText = "$0.00";
    } else {
      oopText = est.ok ? "Incomplete benefits data" : (est.reason || "N/A");
    }

    writes.push(writeText(itemId, COLUMNS.OOP_ESTIMATE, oopText));
    console.log(`[monday] OOP estimate for item ${itemId}: ${oopText}`);
  } catch (err) {
    console.warn(`[monday] OOP estimate failed for item ${itemId}: ${err.message}`);
    writes.push(writeText(itemId, COLUMNS.OOP_ESTIMATE, "Error: " + err.message));
  }

  await Promise.all(writes);
  console.log(`[monday] Reorder token stored for item ${itemId}`);
}

// ─── Query patients where Days to Order = "20 days out" ───
// Uses cursor-based pagination to handle 100+ patients

function parsePatientItem(item) {
  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };

  return {
    itemId: item.id,
    name: item.name,
    uid: col(COLUMNS.PATIENT_UID),
    phone: col(COLUMNS.PHONE),
    nextOrder: col(COLUMNS.NEXT_ORDER),
    reorderTextSent: col(COLUMNS.REORDER_TEXT_SENT),
    reorderToken: col(COLUMNS.REORDER_TOKEN),
  };
}

async function getPatientsAt20DaysOut() {
  const safeBoard = validateNumericId(SUBSCRIPTION_BOARD_ID, "board ID");
  const safeDaysCol = validateColumnId(COLUMNS.DAYS_TO_ORDER);

  const PAGE_SIZE = 500;
  const allItems = [];
  let cursor = null;
  let page = 0;

  // First page — uses items_page_by_column_values (no cursor param on first call)
  const firstData = await mondayQuery(`{
    items_page_by_column_values(
      board_id: ${safeBoard},
      limit: ${PAGE_SIZE},
      columns: [{column_id: "${safeDaysCol}", column_values: ["20 Days"]}]
    ) {
      cursor
      items {
        id name
        column_values { id type text value }
      }
    }
  }`);

  const firstPage = firstData.items_page_by_column_values;
  if (firstPage?.items) {
    allItems.push(...firstPage.items);
  }
  cursor = firstPage?.cursor || null;
  page++;

  // Subsequent pages — use next_items_page with cursor
  while (cursor) {
    console.log(`[monday] Fetching page ${page + 1} of 20-days-out patients (cursor: ${cursor.slice(0, 20)}...)`);

    const nextData = await mondayQuery(`{
      next_items_page(
        limit: ${PAGE_SIZE},
        cursor: "${cursor}"
      ) {
        cursor
        items {
          id name
          column_values { id type text value }
        }
      }
    }`);

    const nextPage = nextData.next_items_page;
    if (nextPage?.items?.length > 0) {
      allItems.push(...nextPage.items);
    }
    cursor = nextPage?.cursor || null;
    page++;

    // Small delay between pages to be nice to Monday API
    if (cursor) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log(`[monday] Total 20-days-out patients fetched: ${allItems.length} across ${page} page(s)`);
  return allItems.map(parsePatientItem);
}

// ─── Mark a patient as having received the reorder text ───

async function markReorderTextSent(itemId, timestamp) {
  const safeId = validateNumericId(itemId, "item ID");
  await writeText(safeId, COLUMNS.REORDER_TEXT_SENT, timestamp || new Date().toISOString());
}

// ─── Read patient data fresh from Monday (for confirmation text) ───

async function getPatientOrderDetails(itemId) {
  const item = await getPatientItemById(itemId);
  if (!item) return null;

  const col = (id) => {
    const c = item.column_values.find((cv) => cv.id === id);
    return c?.text || "";
  };

  const isServing = (val) => val && val !== "Not Serving" && val.trim() !== "";

  const sensorsType = col(COLUMNS.SENSORS_TYPE);
  const suppliesType = col(COLUMNS.SUPPLIES_TYPE);
  const infusionSet1 = col(COLUMNS.INFUSION_SET_1);
  const infusionSet2 = col(COLUMNS.INFUSION_SET_2);

  return {
    name: item.name,
    phone: col(COLUMNS.PHONE),
    address: col(COLUMNS.ADDRESS),
    nextOrder: col(COLUMNS.NEXT_ORDER),
    sensorsType: isServing(sensorsType) ? sensorsType : null,
    suppliesType: isServing(suppliesType) ? suppliesType : null,
    infusionSet1: isServing(infusionSet1) ? infusionSet1 : null,
    infQty1: isServing(infusionSet1) ? col(COLUMNS.INF_QTY_1) : null,
    infusionSet2: isServing(infusionSet2) ? infusionSet2 : null,
    infQty2: isServing(infusionSet2) ? col(COLUMNS.INF_QTY_2) : null,
  };
}

// ─── Initialize write queue ───

function initWriteQueue() {
  try {
    startWorker(mondayQuery);
    _queueEnabled = true;
    console.log("[monday] Write queue enabled");
  } catch (err) {
    console.warn("[monday] Write queue unavailable, using direct writes:", err.message);
    _queueEnabled = false;
  }
  try {
    startReorderWorker();
  } catch (err) {
    console.warn("[monday] Reorder worker unavailable:", err.message);
  }
  try {
    startSmsWorker();
  } catch (err) {
    console.warn("[monday] SMS worker unavailable:", err.message);
  }
  try {
    startSmsVerifyWorker();
  } catch (err) {
    console.warn("[monday] SMS verify worker unavailable:", err.message);
  }
}

module.exports = {
  mondayQuery,
  findPatientByPhone,
  findPatientByUid,
  getPatientItemById,
  getPatientData,
  getPatientOrderDetails,
  processReorderSubmission,
  uploadFileToMonday,
  writeHelpMessage,
  storeTokenInMonday,
  lookupTokenInMonday,
  getStatusIndexMap,
  resolveStatusIndex,
  getPatientsAt20DaysOut,
  markReorderTextSent,
  initWriteQueue,
};
