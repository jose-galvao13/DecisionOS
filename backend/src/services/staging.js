import { randomUUID } from "crypto";

// Preview -> Map Columns -> Commit is two HTTP round trips. Rather than
// re-upload the whole file on commit, we hold the parsed rows here between
// the two calls, keyed by a stagingId, and expire them after 30 minutes.
//
// This is process-local memory: fine for a single instance / MVP. Once you
// run more than one backend instance behind a load balancer, move this to
// Redis (or S3 for the raw rows) so commit doesn't land on a different
// instance than preview did.
const TTL_MS = 30 * 60 * 1000;
const store = new Map(); // stagingId -> { orgId, headers, rows, createdAt }

export function putStaging({ orgId, headers, rows }) {
  const id = randomUUID();
  store.set(id, { orgId, headers, rows, createdAt: Date.now() });
  return id;
}

export function getStaging(id, orgId) {
  const entry = store.get(id);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > TTL_MS) {
    store.delete(id);
    return null;
  }
  if (entry.orgId !== orgId) return null; // never let one org read another's staged upload
  return entry;
}

export function clearStaging(id) {
  store.delete(id);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (now - entry.createdAt > TTL_MS) store.delete(id);
  }
}, 5 * 60 * 1000).unref();
