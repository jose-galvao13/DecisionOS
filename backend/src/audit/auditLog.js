import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";

/** Foundation for roadmap #12. Full "who changed what" UI is FASE 5 —
 *  this just makes sure every FASE-1 mutation is already being recorded,
 *  so that UI has real data to show once it's built. Never throws: a
 *  failed audit write shouldn't fail the request it's logging. */
export async function writeAudit({ orgId, userId, action, objectType, objectId, before = null, after = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_log (id, org_id, user_id, action, object_type, object_id, before, after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), orgId, userId, action, objectType || null, objectId || null, before, after]
    );
  } catch (e) {
    console.error("[audit] failed to write audit log entry", action, e.message);
  }
}
