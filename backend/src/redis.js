const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    return Math.min(times * 200, 5000);
  },
});

redis.on("error", (err) => console.error("[redis] Error:", err.message));
redis.on("connect", () => console.log("[redis] Connected"));

// ─── Reorder token storage ───
// Token is stored in both Redis (for fast lookup) and Monday (for audit trail)

async function storeReorderToken(token, uid, itemId, ttl) {
  // Store both the patient UID and the specific Monday row (itemId) this token
  // belongs to. itemId is the source of truth for routing writes — a patient can
  // have multiple rows sharing one UID (e.g. separate sensors/supplies lines),
  // so UID alone is ambiguous.
  const payload = JSON.stringify({ uid, itemId: itemId != null ? String(itemId) : null });
  await redis.set(`reorder:${token}`, payload, "EX", ttl);
}

async function getReorderToken(token) {
  const raw = await redis.get(`reorder:${token}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.uid) {
      return { uid: parsed.uid, itemId: parsed.itemId != null ? String(parsed.itemId) : null };
    }
  } catch {
    // Legacy format: raw value was the bare UID string (pre-itemId tokens)
  }
  return { uid: raw, itemId: null };
}

async function deleteReorderToken(token) {
  await redis.del(`reorder:${token}`);
}

// ─── Auth rate limiting ───

async function checkAuthRateLimit(key, maxRequests, windowSeconds) {
  const redisKey = `auth_rate:${key}`;
  const current = await redis.incr(redisKey);
  if (current === 1) {
    await redis.expire(redisKey, windowSeconds);
  }
  return current <= maxRequests;
}

// ─── Session storage (JWT blacklist for logout) ───

async function blacklistSession(jti, expiresInSeconds) {
  await redis.set(`blacklist:${jti}`, "1", "EX", expiresInSeconds);
}

async function isSessionBlacklisted(jti) {
  const val = await redis.get(`blacklist:${jti}`);
  return val === "1";
}

// ─── Patient data cache ───

async function cachePatientData(uid, data, ttl = 300) {
  await redis.set(`patient:${uid}`, JSON.stringify(data), "EX", ttl);
}

async function getCachedPatientData(uid) {
  const raw = await redis.get(`patient:${uid}`);
  return raw ? JSON.parse(raw) : null;
}

async function invalidatePatientCache(uid) {
  await redis.del(`patient:${uid}`);
}

// ─── Submission lock (prevent double submission) ───

async function acquireSubmissionLock(uid, ttlSeconds = 30) {
  const key = `submit_lock:${uid}`;
  const result = await redis.set(key, "1", "EX", ttlSeconds, "NX");
  return result === "OK";
}

async function releaseSubmissionLock(uid) {
  await redis.del(`submit_lock:${uid}`);
}

async function markSubmitted(uid, ttlSeconds = 86400) {
  await redis.set(`submitted:${uid}`, Date.now().toString(), "EX", ttlSeconds);
}

async function hasSubmitted(uid) {
  const val = await redis.get(`submitted:${uid}`);
  return !!val;
}

// ─── Idempotency key (prevents duplicate submissions on retry) ───

async function getIdempotencyResult(key) {
  const raw = await redis.get(`idempotent:${key}`);
  return raw ? JSON.parse(raw) : null;
}

async function setIdempotencyResult(key, result, ttlSeconds = 3600) {
  await redis.set(`idempotent:${key}`, JSON.stringify(result), "EX", ttlSeconds);
}

// ─── Health check ───

async function healthCheck() {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  redis,
  storeReorderToken, getReorderToken, deleteReorderToken,
  checkAuthRateLimit,
  blacklistSession, isSessionBlacklisted,
  cachePatientData, getCachedPatientData, invalidatePatientCache,
  acquireSubmissionLock, releaseSubmissionLock, markSubmitted, hasSubmitted,
  getIdempotencyResult, setIdempotencyResult,
  healthCheck,
};
