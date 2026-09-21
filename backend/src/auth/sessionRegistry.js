/* ---------------------------------------------------------------
   SESSION REGISTRY — who may no longer use the tokens they hold.

   Tokens are stateless JWTs (7 days). Checking the database on every
   request would change the cost of every route, so instead the small set of
   people whose sessions were cut (deactivated, password reset, role changed)
   is kept in memory and consulted synchronously by requireAuth. It is filled
   from the users table on startup (services/userAdmin.js -> loadSessionState)
   and updated whenever one of those actions happens.

   Deliberately in-process: correct for the single-instance deployment this
   app runs as (API + worker in one process, or the desktop app). Running
   several API instances would need this shared (Redis, or a users lookup
   with a short cache) — noted, not needed today.
----------------------------------------------------------------*/
const state = new Map(); // userId -> { disabled: boolean, validAfter: number (epoch seconds) }

export function isTokenRevoked(payload) {
  const s = state.get(payload?.sub);
  if (!s) return false;
  if (s.disabled) return true;
  // `iat` is in whole seconds, so a token minted in the same second as the
  // revocation still counts as new — that is what lets someone sign back in
  // (or get a fresh token after changing their own password) immediately.
  return s.validAfter > 0 && (payload.iat ?? 0) < s.validAfter;
}

export function setSessionState(userId, patch) {
  const current = state.get(userId) || { disabled: false, validAfter: 0 };
  state.set(userId, { ...current, ...patch });
}

export function clearSessionRegistry() {
  state.clear();
}
