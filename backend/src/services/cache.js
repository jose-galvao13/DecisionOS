/* ---------------------------------------------------------------
   CACHE — FASE 8 ("Cache onde fizer sentido"). A tiny in-process TTL
   cache, not Redis: this backend already keeps process-local state
   (services/staging.js works the same way) and documents the same
   trade-off — fine for a single instance, move to Redis if this
   backend ever runs as more than one instance behind a load
   balancer, because invalidation below only affects the instance
   that received the write.
----------------------------------------------------------------*/
const store = new Map(); // key -> { value, expiresAt }

export function getCached(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function setCached(key, value, ttlMs = 60_000) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function invalidate(key) {
  store.delete(key);
}

/** Drop every cached entry whose key starts with `prefix` — used to
 *  invalidate all cached analytics for one org (every filter
 *  combination) in one call after an import/refresh completes. */
export function invalidateByPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

export function clearAll() {
  store.clear();
}

// Passive cleanup so expired entries don't sit in memory forever between
// reads of the same key.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 5 * 60 * 1000).unref();
