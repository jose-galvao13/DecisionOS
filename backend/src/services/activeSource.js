/* ---------------------------------------------------------------
   ACTIVE DATA SOURCE

   An organization can keep several data sources (uploaded Excel files,
   connected databases). Only one of them at a time feeds the analytics,
   the AI advisor, the decision engine and the reports — otherwise their
   rows would be silently summed together and every number would be
   wrong. Every read of `transactions` for analytics goes through
   getActiveDataSourceId().

   Resolution order:
     1. organizations.active_data_source_id, if that source still exists,
        belongs to the org and has imported rows (a source that is only
        re-syncing keeps counting — its old rows stay until the re-import
        commits, so the dashboards don't flicker during a refresh);
     2. otherwise the newest 'connected' source that has rows;
     3. otherwise null -> the org has no usable data yet.
----------------------------------------------------------------*/
import { pool } from "../db/pool.js";

export async function getActiveDataSourceId(orgId, db = pool) {
  const { rows } = await db.query(
    `SELECT COALESCE(
       (SELECT d.id
          FROM organizations o
          JOIN data_sources d ON d.id = o.active_data_source_id
         WHERE o.id = $1 AND d.org_id = $1
           AND d.status IN ('connected', 'syncing') AND d.row_count > 0),
       (SELECT d.id
          FROM data_sources d
         WHERE d.org_id = $1 AND d.status = 'connected' AND d.row_count > 0
         ORDER BY d.created_at DESC
         LIMIT 1)
     ) AS id`,
    [orgId]
  );
  return rows[0]?.id ?? null;
}

export async function setActiveDataSource(orgId, dataSourceId, db = pool) {
  await db.query(`UPDATE organizations SET active_data_source_id = $2 WHERE id = $1`, [orgId, dataSourceId]);
}
