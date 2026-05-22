# Cache Logic — Reorder Patient Form

## Current Approach: No Cache

Patient data is fetched directly from Monday.com on every page load. There is no Redis caching layer for patient data.

**Why:** This is a single-use form. The patient opens the link, fills it out, and submits. There's no multi-page navigation that would benefit from caching. Fresh data on every load ensures any last-minute Monday updates (address corrections, insurance changes by staff, etc.) are always reflected.

## Previous Approach (Removed)

The reference repo (mm-subscriber-portal) cached patient data in Redis for 15 minutes (900s). That made sense for a multi-page portal with repeated API calls within a session. It was carried over during initial build but removed because it caused stale data issues — staff would update Monday and the patient would still see old info.

## If We Need Cache Later

If Monday rate limits become a problem (many patients opening links at once), add a short TTL cache:

```js
// In GET /api/me handler:
let data = await getCachedPatientData(req.uid);
if (!data) {
  data = await getPatientData(req.uid);
  await cachePatientData(req.uid, data, 30); // 30 seconds
}
```

The Redis functions (`getCachedPatientData`, `cachePatientData`, `invalidatePatientCache`) are still exported from `redis.js` and ready to use. The submit handler already calls `invalidatePatientCache` after a successful write, so post-submission refreshes would always be fresh regardless of cache TTL.

## What IS Still Cached in Redis

- **Reorder tokens** — stored with a 7-day TTL, deleted after successful form submission
- **Rate limit counters** — for auth attempts and API requests
- **Submission locks** — short-lived locks to prevent double-submit
- **Session blacklist** — for invalidated JWTs after logout
