const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { AUTH } = require("./config");
const {
  storeReorderToken, getReorderToken, deleteReorderToken,
  checkAuthRateLimit, blacklistSession, isSessionBlacklisted,
} = require("./redis");
const { lookupTokenInMonday } = require("./monday");

const JWT_SECRET = process.env.JWT_SECRET;

// ═══════════════════════════════════════════════════════
// DIRECT TOKEN AUTH FLOW
// ═══════════════════════════════════════════════════════
//
// Unlike the subscriber portal (which uses phone → magic link → verify),
// the reorder form uses a DIRECT TOKEN link:
//
// 1. System generates a reorder token and stores it in Redis + Monday
// 2. SMS is sent with link: https://reorder.example.com?token=<TOKEN>
// 3. Patient clicks link → token is verified → JWT session issued
// 4. Patient fills out form within that session
//
// The token is REUSABLE: it stays alive in Redis until its TTL expires
// (20 days by default — matches the reorder cycle window). Each click
// issues a fresh JWT session (24h). Patient can re-open the link anytime.

// ─── Generate a reorder token for a patient ───

async function generateReorderToken(uid) {
  const token = crypto.randomBytes(AUTH.TOKEN_BYTES).toString("hex");
  await storeReorderToken(token, uid, AUTH.TOKEN_TTL);
  console.log(`[auth] Reorder token generated for UID ${uid}`);
  return token;
}

// ─── Verify reorder token → issue JWT session ───

async function verifyReorderToken(token) {
  if (!token || token.length !== AUTH.TOKEN_BYTES * 2) {
    return { error: "Invalid link", status: 400 };
  }

  // Rate limit by token prefix to prevent brute force
  const tokenPrefix = token.slice(0, 8);
  const allowed = await checkAuthRateLimit(`token:${tokenPrefix}`, AUTH.RATE_LIMIT_AUTH, AUTH.RATE_LIMIT_AUTH_WINDOW);
  if (!allowed) {
    return { error: "Too many attempts. Please try again later.", status: 429 };
  }

  // Lookup token in Redis first, fall back to Monday if Redis missed (restart/flush)
  let uid = await getReorderToken(token);
  if (!uid) {
    try {
      uid = await lookupTokenInMonday(token);
      if (uid) {
        // Re-seed Redis so subsequent requests are fast
        await storeReorderToken(token, uid, AUTH.TOKEN_TTL);
        console.log(`[auth] Token re-seeded in Redis from Monday fallback for UID ${uid}`);
      }
    } catch (err) {
      console.error(`[auth] Monday fallback lookup failed:`, err.message);
    }
  }
  if (!uid) {
    return { error: "This link has expired or already been used. Please contact us for a new one.", status: 401 };
  }

  // Token stays alive — patient can re-open the link until TTL expires

  // Generate JWT
  const jti = crypto.randomUUID();
  const jwtToken = jwt.sign(
    { uid, jti, purpose: "reorder", reorderToken: token },
    JWT_SECRET,
    { expiresIn: AUTH.JWT_EXPIRY, issuer: "mm-reorder-form" }
  );

  console.log(`[auth] Reorder session created for UID ${uid} (jti: ${jti})`);

  return {
    success: true,
    jwt: jwtToken,
    uid,
    expiresIn: AUTH.JWT_EXPIRY,
  };
}

// ─── JWT authentication middleware ───

function requireAuth(req, res, next) {
  // Check cookie first, then Authorization header
  let token = req.cookies?.session;
  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }
  if (!token) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { issuer: "mm-reorder-form" });
    req.uid = payload.uid;
    req.jti = payload.jti;
    req.reorderToken = payload.reorderToken;

    // Check blacklist
    isSessionBlacklisted(payload.jti).then((blacklisted) => {
      if (blacklisted) {
        return res.status(401).json({ error: "Session expired" });
      }
      next();
    }).catch((err) => {
      console.error("[auth] Blacklist check failed:", err.message);
      // Fail open — JWT is still cryptographically valid, allow the request
      next();
    });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Session expired. Please use your original link to start a new session." });
    }
    return res.status(401).json({ error: "Invalid session" });
  }
}

// ─── Logout ───

async function logout(jti, exp) {
  const remaining = exp - Math.floor(Date.now() / 1000);
  if (remaining > 0) {
    await blacklistSession(jti, remaining);
  }
}

// ─── Cookie config ───

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "none",
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
  path: "/",
};

module.exports = {
  generateReorderToken,
  verifyReorderToken,
  requireAuth,
  logout,
  COOKIE_OPTIONS,
};
