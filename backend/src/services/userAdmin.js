import { pool } from "../db/pool.js";
import { setSessionState } from "../auth/sessionRegistry.js";

/** Cuts every token this person already holds (they have to sign in again). */
export async function revokeUserSessions(userId, db = pool) {
  const validAfter = Math.floor(Date.now() / 1000);
  await db.query(`UPDATE users SET sessions_valid_after = to_timestamp($2) WHERE id = $1`, [userId, validAfter]);
  setSessionState(userId, { validAfter });
}

/** Deactivate / reactivate. Deactivating also cuts their sessions. */
export async function setUserDisabled(userId, disabled, db = pool) {
  await db.query(`UPDATE users SET disabled_at = CASE WHEN $2::boolean THEN now() ELSE NULL END WHERE id = $1`, [userId, disabled]);
  setSessionState(userId, { disabled });
  if (disabled) await revokeUserSessions(userId, db);
}

/** Startup: rebuild the in-memory registry from the database, so a restart
 *  doesn't quietly re-admit someone who was deactivated. Looks back 30 days
 *  for revoked sessions (a token lives 7 by default). */
export async function loadSessionState(db = pool) {
  const { rows } = await db.query(
    `SELECT id, disabled_at, EXTRACT(EPOCH FROM sessions_valid_after)::bigint AS valid_after
     FROM users
     WHERE disabled_at IS NOT NULL OR sessions_valid_after > now() - interval '30 days'`
  );
  for (const r of rows) setSessionState(r.id, { disabled: !!r.disabled_at, validAfter: Number(r.valid_after) || 0 });
  return rows.length;
}
