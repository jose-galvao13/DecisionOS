/* ---------------------------------------------------------------
   ACTIVE DATA SOURCE(S)

   An organization can keep several data sources (uploaded Excel files,
   connected databases). Any number of them can be marked "active" at once;
   together they feed the analytics, the AI advisor, the decision engine and
   the reports — a source that isn't active is kept (its data isn't
   deleted) but doesn't count towards any of that. Every read of
   `transactions` for analytics goes through getActiveDataSourceIds().

   Resolution:
     - every data_sources row with is_active = true, belonging to the org,
       whose status is 'connected' or 'syncing' and has row_count > 0 (a
       source that is only re-syncing keeps counting — its old rows stay
       until the re-import commits, so the dashboards don't flicker during
       a refresh);
     - if nothing is marked active (a brand new org, or every active source
       got removed), fall back to the single newest 'connected' source with
       rows, exactly like the old single-active-source behaviour, so an org
       is never left staring at an empty dashboard for no reason.
----------------------------------------------------------------*/
import { pool } from "../db/pool.js";

const ACTIVE_OR_FALLBACK_SQL = `
  WITH active AS (
    SELECT id, name, created_at FROM data_sources
     WHERE org_id = $1 AND is_active = true
       AND status IN ('connected', 'syncing') AND row_count > 0
  )
  SELECT id, name FROM active
  UNION ALL
  SELECT id, name FROM (
    SELECT id, name FROM data_sources
     WHERE org_id = $1 AND status = 'connected' AND row_count > 0
       AND NOT EXISTS (SELECT 1 FROM active)
     ORDER BY created_at DESC
     LIMIT 1
  ) fallback
`;

/** Every data source id that currently feeds this org's analytics, oldest
 *  import first isn't guaranteed — callers that need a stable order should
 *  sort further. Empty array means "no usable data yet". */
export async function getActiveDataSourceIds(orgId, db = pool) {
  const { rows } = await db.query(ACTIVE_OR_FALLBACK_SQL, [orgId]);
  return rows.map((r) => r.id);
}

/** Back-compat shim for callers that only ever need a single id (e.g. a
 *  quick quality lookup) — the first of the active set, or the lone
 *  fallback source. Prefer getActiveDataSourceIds() for anything that
 *  reads transactions, or the numbers will silently miss other active files. */
export async function getActiveDataSourceId(orgId, db = pool) {
  const ids = await getActiveDataSourceIds(orgId, db);
  return ids[0] ?? null;
}

/** Turn one data source on/off for this org's combined analytics. Callers
 *  (routes/datasources.routes.js) are responsible for refusing to turn off
 *  the last active source — this function will happily leave an org with
 *  zero active sources if asked to. */
export async function setDataSourceActive(orgId, dataSourceId, isActive, db = pool) {
  await db.query(`UPDATE data_sources SET is_active = $3 WHERE id = $2 AND org_id = $1`, [orgId, dataSourceId, !!isActive]);
}
