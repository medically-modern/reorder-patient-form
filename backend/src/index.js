const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { RedisStore } = require("rate-limit-redis");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const { verifyReorderToken, generateReorderToken, requireAuth, logout, COOKIE_OPTIONS } = require("./auth");
const {
  getPatientData, getPatientOrderDetails, processReorderSubmission, findPatientByPhone,
  storeTokenInMonday, getStatusIndexMap, resolveStatusIndex, initWriteQueue,
} = require("./monday");
const { sendSMS, buildConfirmationText, smsHealthCheck } = require("./sms");
const { uploadInsuranceCard, getFile } = require("./s3");
const { queueHealthCheck } = require("./queue");
const { startCron, checkAndProcessReorders } = require("./cron");
const { notifySubmissionError, notifySmsError, notifyUnhandled, notifyError } = require("./notify");
const { redis, healthCheck, getCachedPatientData, cachePatientData, invalidatePatientCache, acquireSubmissionLock, releaseSubmissionLock, markSubmitted, hasSubmitted, deleteReorderToken } = require("./redis");

const app = express();

// ─── Multer for file uploads (insurance cards) ───
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,   // 10MB max per file
    files: 2,                      // Front + back of insurance card
  },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed. Please upload JPEG, PNG, HEIC, or PDF.`));
    }
  },
});

// ─── Security headers ───
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'"],
      "style-src": ["'self'", "https:", "'unsafe-inline'"],
      "font-src": ["'self'", "https:", "data:"],
      "img-src": ["'self'", "data:", "https:"],
    },
  },
}));

// ─── CORS ───
const ALLOWED_ORIGINS = [
  "https://medically-modern.github.io",
  "https://reorder.medicallymodern.com",
  process.env.REORDER_URL,
].filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.some((o) => origin.startsWith(o))) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());
app.set("trust proxy", 1);

// ─── Rate limiters ───
const redisStore = (prefix) => new RedisStore({ sendCommand: (...args) => redis.call(...args), prefix: `rl:reorder:${prefix}:` });
const globalLimiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false, store: redisStore("global") });
const authLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false, store: redisStore("auth") });
const apiLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, store: redisStore("api") });

app.use(globalLimiter);

// ─── Health check ───
app.get("/health", async (req, res) => {
  const redisOk = await healthCheck();
  const queue = queueHealthCheck();
  const sms = smsHealthCheck();
  res.json({
    status: "ok",
    service: "reorder-patient-form",
    redis: redisOk ? "connected" : "disconnected",
    queue,
    sms,
    cron: "active",
    timestamp: new Date().toISOString(),
  });
});

// ─── Frontend config ───
app.get("/api/config", (req, res) => {
  res.json({
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null,
  });
});

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════

// GET /auth/verify/:token — Verify reorder token, issue session
app.get("/auth/verify/:token", authLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const result = await verifyReorderToken(token);

    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }

    // Set session cookie
    res.cookie("session", result.jwt, COOKIE_OPTIONS);

    // Also return in body for cross-origin
    res.json({ success: true, uid: result.uid, token: result.jwt });
  } catch (err) {
    console.error("[auth] Error verifying reorder token:", err.message);
    notifyError("Token Verify Error", `Token verification failed: ${err.message}`, { tags: ["lock"] });
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// GET /auth/check — Check if session is valid
app.get("/auth/check", requireAuth, (req, res) => {
  res.json({ authenticated: true, uid: req.uid });
});

// POST /auth/logout — End session
app.post("/auth/logout", requireAuth, async (req, res) => {
  try {
    const jwt = require("jsonwebtoken");
    const sessionToken = req.cookies?.session || req.headers.authorization?.slice(7);
    const decoded = jwt.decode(sessionToken);
    if (decoded?.jti && decoded?.exp) {
      await logout(decoded.jti, decoded.exp);
    }
    res.clearCookie("session", { ...COOKIE_OPTIONS, maxAge: 0 });
    res.json({ success: true });
  } catch (err) {
    console.error("[auth] Logout error:", err.message);
    res.clearCookie("session", { ...COOKIE_OPTIONS, maxAge: 0 });
    res.json({ success: true });
  }
});

// ═══════════════════════════════════════════════════════
// ADMIN ROUTE — Generate reorder token for a patient
// This would be called by the command center / automation
// to create the reorder link 20 days before order date
// ═══════════════════════════════════════════════════════

app.post("/admin/generate-token", async (req, res) => {
  try {
    // Simple API key auth for admin routes
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { phone, uid } = req.body;
    if (!phone && !uid) {
      return res.status(400).json({ error: "Phone or UID required" });
    }

    let patientUid = uid;
    let patientPhone = phone;

    // If phone provided, look up the patient
    if (phone && !uid) {
      const patient = await findPatientByPhone(phone);
      if (!patient || !patient.uid) {
        return res.status(404).json({ error: "Patient not found" });
      }
      patientUid = patient.uid;
      patientPhone = patient.phone;
    }

    // Generate token
    const token = await generateReorderToken(patientUid);
    const reorderUrl = process.env.REORDER_URL || "https://reorder.medicallymodern.com";
    const link = `${reorderUrl}?token=${token}`;

    // Store token + link in Monday
    await storeTokenInMonday(patientUid, token, link);

    console.log(`[admin] Reorder token generated for UID ${patientUid}`);

    res.json({
      success: true,
      uid: patientUid,
      link,
      token,
      expiresIn: "20 days",
    });
  } catch (err) {
    console.error("[admin] Error generating token:", err.message, err.stack);
    res.status(500).json({ error: "Failed to generate reorder token" });
  }
});

// POST /admin/trigger-reorder-check — Manually trigger the cron job
app.post("/admin/trigger-reorder-check", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("[admin] Manual reorder check triggered");
    const result = await checkAndProcessReorders();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("[admin] Manual reorder check failed:", err.message);
    res.status(500).json({ error: "Reorder check failed" });
  }
});

// ═══════════════════════════════════════════════════════
// CONFIRMATION TEXT — sent after patient submits the form
// ═══════════════════════════════════════════════════════

async function sendConfirmationTextAfterDelay(uid, optOuts = {}) {
  // Wait for Monday writes to settle
  const DELAY_MS = 20_000; // 20 seconds
  console.log(`[sms] Waiting ${DELAY_MS / 1000}s before sending confirmation text for UID ${uid}...`);
  await new Promise((r) => setTimeout(r, DELAY_MS));

  // Re-read from Monday to get the actual written values
  const details = await getPatientOrderDetails(uid);
  if (!details) {
    console.error(`[sms] Cannot send confirmation — patient ${uid} not found in Monday`);
    return;
  }

  if (!details.phone) {
    console.error(`[sms] Cannot send confirmation — no phone for UID ${uid}`);
    return;
  }

  const messageText = buildConfirmationText({
    name: details.name,
    address: details.address,
    nextOrder: details.nextOrder,
    sensorsType: optOuts.sensorsOptOut ? null : details.sensorsType,
    suppliesType: optOuts.cartridgesOptOut ? null : details.suppliesType,
    infusionSet1: optOuts.infusionOptOut ? null : details.infusionSet1,
    infQty1: optOuts.infusionOptOut ? null : details.infQty1,
    infusionSet2: optOuts.infusionOptOut ? null : details.infusionSet2,
    infQty2: optOuts.infusionOptOut ? null : details.infQty2,
  });

  await sendSMS(details.phone, messageText, { patientName: details.name });
  console.log(`[sms] Confirmation text sent to UID ${uid}`);
}

// ═══════════════════════════════════════════════════════
// PATIENT API ROUTES (all require auth)
// ═══════════════════════════════════════════════════════

// GET /api/me — Full patient data for reorder form
app.get("/api/me", apiLimiter, requireAuth, async (req, res) => {
  try {
    // Always pull fresh from Monday — no cache
    const data = await getPatientData(req.uid);
    if (!data) {
      return res.status(404).json({ error: "Patient not found" });
    }

    // Strip internal fields
    const { itemId, ...safeData } = data;
    res.json(safeData);
  } catch (err) {
    console.error("[api] Error fetching patient data:", err.message);
    res.status(500).json({ error: "Unable to load your data. Please try again." });
  }
});

// GET /api/order-options — Get dropdown options for order fields
app.get("/api/order-options", apiLimiter, requireAuth, async (req, res) => {
  try {
    const indexMap = await getStatusIndexMap();

    // Build human-readable options from the index map
    const buildOptions = (columnId) => {
      const colMap = indexMap[columnId];
      if (!colMap) return [];
      return Object.entries(colMap)
        .filter(([label]) => label && label !== "not serving" && label.trim() !== "")
        .map(([label, index]) => ({
          label: label.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
          index,
        }))
        .sort((a, b) => a.index - b.index);
    };

    res.json({
      sensorsTypes: buildOptions(COLUMNS.SENSORS_TYPE),
      suppliesTypes: buildOptions(COLUMNS.SUPPLIES_TYPE),
      infusionSets: buildOptions(COLUMNS.INFUSION_SET_1),
      insuranceTypes: [
        "United", "Aetna", "Cigna", "Anthem BCBS", "Medicare",
        "Medicaid", "NYSHIP", "Fidelis", "WellCare", "Humana", "Other",
      ],
    });
  } catch (err) {
    console.error("[api] Error fetching order options:", err.message);
    res.status(500).json({ error: "Unable to load options." });
  }
});

// POST /api/submit — Submit the reorder form
app.post("/api/submit", apiLimiter, requireAuth, async (req, res) => {
  try {
    // Prevent double submission
    const lockAcquired = await acquireSubmissionLock(req.uid);
    if (!lockAcquired) {
      return res.status(409).json({ error: "Your form is already being submitted. Please wait." });
    }

    try {
      const submission = req.body;

      // Idempotency: if this patient already submitted a real order response,
      // return cached success to prevent double-writes (e.g. lost response on bad internet).
      // NEVER block help-only messages — patients can send multiple.
      if (submission.response !== "help-only" && await hasSubmitted(req.uid)) {
        const messages = {
          confirm: "Thank you! Your order has been confirmed. We'll begin processing it shortly. Please reach out if anything changes.",
          delay: "Thank you! Your order has been successfully delayed. We'll reach out again before your new order date.",
          cancel: "We're sad to see you go! We'll cancel all ongoing reorders. Please text/call us if this was a mistake.",
        };
        console.log(`[api] Duplicate submit detected for UID ${req.uid} (response: ${submission.response}) — returning cached success`);
        return res.json({ success: true, message: messages[submission.response] || messages.confirm });
      }

      // Validate required fields
      if (!submission.response || !["confirm", "delay", "cancel", "help-only"].includes(submission.response)) {
        return res.status(400).json({ error: "Invalid response. Must be confirm, delay, or cancel." });
      }

      // Validate delay-specific fields
      if (submission.response === "delay" && !submission.indefinite && !submission.newOrderDate) {
        return res.status(400).json({ error: "Please select a new order date or choose indefinitely." });
      }

      // Validate new order date cannot be earlier than current order date
      if (submission.response === "delay" && submission.newOrderDate && submission.currentOrderDate) {
        const newDate = new Date(submission.newOrderDate);
        const currentDate = new Date(submission.currentOrderDate);
        if (newDate < currentDate) {
          return res.status(400).json({
            error: "Sorry, this is the earliest insurance will cover your reorder. Please text/call us if there is an extraordinary situation where your order date needs to be pushed up.",
          });
        }
      }

      // Validate ZIP code in address if changed
      if (submission.addressChange?.address) {
        const zipMatch = submission.addressChange.address.match(/\b(\d{5})\b/);
        if (!zipMatch) {
          return res.status(400).json({ error: "Address must include a valid 5-digit ZIP code." });
        }
      }

      // Validate insurance fields if changed
      if (submission.insuranceResponse === "changed") {
        if (!submission.newInsuranceType) {
          return res.status(400).json({ error: "Please select your new insurance type." });
        }
        if (!submission.newMemberId) {
          return res.status(400).json({ error: "Please enter your new member ID." });
        }
      }

      // Validate infusion set quantities
      if (submission.orderChanges) {
        const qty1 = parseFloat(submission.orderChanges.infQty1) || 0;
        const qty2 = parseFloat(submission.orderChanges.infQty2) || 0;
        const totalQty = qty1 + qty2;

        // Check insurance-specific limits
        const maxQty = submission.isAnthemOrCigna ? 9 : 3;
        if (totalQty > maxQty) {
          return res.status(400).json({
            error: `Total infusion set quantity cannot exceed ${maxQty}. Current total: ${totalQty}.`,
          });
        }
      }

      const result = await processReorderSubmission(req.uid, submission);

      if (result.partial) {
        return res.status(207).json({
          success: false,
          message: `Saved ${result.saved} field(s), but some had issues.`,
          failures: result.failures,
        });
      }

      // Return success with response-specific message
      const messages = {
        confirm: "Thank you! Your order has been confirmed. We'll begin processing it shortly. Please reach out if anything changes.",
        delay: submission.indefinite
          ? "Thank you! Your order has been paused. When you're ready to resume, please text or call us to set a new order date."
          : "Thank you! Your order has been successfully delayed. We'll reach out again before your new order date.",
        cancel: "We're sad to see you go! We'll cancel all ongoing reorders. Please text/call us if this was a mistake.",
      };

      // For delay < 20 days, use confirm message
      let message = messages[submission.response];
      if (submission.response === "delay" && submission.delayLessThan20Days) {
        message = messages.confirm;
      }

      // Invalidate the reorder token so the link can't be reused after submission
      // In production mode, delete the token. In test mode, keep it alive for re-testing.
      if (req.reorderToken && process.env.PRODUCTION_MODE === "true") {
        await deleteReorderToken(req.reorderToken);
        console.log(`[auth] Reorder token invalidated after submission for UID ${req.uid}`);
      } else {
        console.log(`[auth] Test mode — token kept alive after submission for UID ${req.uid}`);
      }

      // Mark as submitted so duplicate requests return cached success
      // Only for real order responses — help-only messages can be sent multiple times
      if (submission.response !== "help-only") {
        await markSubmitted(req.uid);
      }

      res.json({ success: true, message });

      // ─── Fire-and-forget: send confirmation text after Monday writes settle ───
      // Send for confirm and delay responses (not cancel — patient is leaving)
      if (submission.response === "confirm" || submission.response === "delay") {
        // Pass opt-out flags so confirmation text excludes skipped items
        const optOuts = {
          sensorsOptOut: submission.orderChanges?.sensorsOptOut || false,
          cartridgesOptOut: submission.orderChanges?.cartridgesOptOut || false,
          infusionOptOut: submission.orderChanges?.infusionOptOut || false,
        };
        sendConfirmationTextAfterDelay(req.uid, optOuts).catch((err) => {
          console.error(`[sms] Confirmation text failed for UID ${req.uid}:`, err.message);
          notifySmsError(`Confirmation text failed: ${err.message}`, req.uid);
        });
      }
    } finally {
      await releaseSubmissionLock(req.uid);
    }
  } catch (err) {
    console.error("[api] Submit error:", err.message, err.stack);
    await notifySubmissionError(`Submit failed: ${err.message}`, req.uid);
    await releaseSubmissionLock(req.uid).catch(() => {});
    res.status(500).json({ error: "Failed to submit your form. Please try again." });
  }
});

// POST /api/upload-insurance-card — Upload insurance card images
app.post("/api/upload-insurance-card", apiLimiter, requireAuth, upload.array("cards", 2), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded" });
    }

    // Look up patient's Monday item ID for file column upload
    const { findPatientByUid, uploadFileToMonday } = require("./monday");
    const { COLUMNS } = require("./config");
    const patient = await findPatientByUid(req.uid);
    const itemId = patient ? patient.id : null;

    const urls = [];
    const mondayResults = [];

    for (const file of req.files) {
      // Save to Railway volume (local backup)
      const result = await uploadInsuranceCard(
        file.buffer,
        file.originalname,
        file.mimetype,
        req.uid
      );
      urls.push(result.url);

      // Upload to Monday Insurance Card file column
      if (itemId) {
        const mondayResult = await uploadFileToMonday(
          itemId,
          COLUMNS.INSURANCE_CARD,
          file.buffer,
          file.originalname
        );
        mondayResults.push(mondayResult);
      }
    }

    const mondayFails = mondayResults.filter(r => !r.success);
    if (mondayFails.length > 0) {
      console.warn(`[api] ${mondayFails.length} Monday file upload(s) failed for UID ${req.uid}:`, mondayFails);
    }

    console.log(`[api] Insurance cards uploaded for UID ${req.uid}: ${urls.length} file(s), Monday: ${mondayResults.length - mondayFails.length}/${mondayResults.length} succeeded`);
    res.json({ success: true, urls, mondayUploaded: mondayFails.length === 0 });
  } catch (err) {
    console.error("[api] Upload error:", err.message);
    if (err.message.includes("File type")) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: "Failed to upload files. Please try again." });
  }
});

// ─── Serve uploaded files (insurance cards from Railway volume) ───
app.get("/files/:uid/:filename", requireAuth, (req, res) => {
  const key = `${req.params.uid}/${req.params.filename}`;
  // Only allow patients to access their own files
  if (req.params.uid !== req.uid) {
    return res.status(403).json({ error: "Access denied" });
  }
  const file = getFile(key);
  if (!file) {
    return res.status(404).json({ error: "File not found" });
  }
  res.set("Content-Type", file.mimeType);
  res.set("Content-Disposition", `inline; filename="${file.originalName}"`);
  res.send(file.buffer);
});

// ─── Error handler for multer ───
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Maximum size is 10MB." });
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: "Too many files. Maximum is 2 (front and back of card)." });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ─── Start server ───
const PORT = process.env.PORT || 3001;

// Import COLUMNS here for the order-options route
const { COLUMNS } = require("./config");

app.listen(PORT, () => {
  console.log(`[reorder-api] Reorder patient form backend running on port ${PORT}`);
  initWriteQueue();
  startCron();
});

// ─── Global error handlers → ntfy ───
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  notifyUnhandled("Exception", err);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error("[FATAL] Unhandled rejection:", err);
  notifyUnhandled("Rejection", err);
});
