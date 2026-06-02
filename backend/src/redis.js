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

async function storeReorderToken(token, uid, ttl) {
  await redis.set(`reorder:${token}`, uid, "EX", ttl);
}

async function getReorderToken(token) {
  return redis.get(`reorder:${token}`);
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
  healthCheck,
};
