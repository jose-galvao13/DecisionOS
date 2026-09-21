/* ---------------------------------------------------------------
   DUPLICATE PROTECTION — for "several active files at once".

   Two files can legitimately cover the same period on purpose (e.g. one
   file per business unit for the same month), so an overlapping date range
   alone is not treated as an error — it's just the trigger to look closer.
   What actually matters is whether they contain the *same rows*: same
   date + customer + product + revenue. If they do, activating both would
   silently double-count that revenue, which is exactly the failure mode
   this whole feature exists to prevent.

   Mixed currencies are a separate, already-handled concern (fx_rates.js +
   the mixed_currencies warning in analyticsEngine.js) — this module only
   flags rows that are identical on the fields above, so it won't fire for
   two files that happen to cover the same dates in different currencies.
----------------------------------------------------------------*/
import { pool } from "../db/pool.js";

/** Returns the [min, max] date range covered by one data source, or null
 *  if it has no imported rows yet. */
async function dateRangeOf(orgId, dataSourceId, db) {
  const { rows } = await db.query(
    `SELECT MIN(date) AS min, MAX(date) AS max FROM transactions WHERE org_id = $1 AND data_source_id = $2`,
    [orgId, dataSourceId]
  );
  const r = rows[0];
  return r?.min ? { min: r.min, max: r.max } : null;
}

function rangesOverlap(a, b) {
  return new Date(a.min) <= new Date(b.max) && new Date(b.min) <= new Date(a.max);
}

/** How many rows in `candidateId` look identical (same date, customer,
 *  product and net revenue) to a row already in `otherId`. Compared at the
 *  unified-model level (customer/product names, not raw file text), so it
 *  still catches duplicates between an Excel upload and a live DB source. */
async function countMatchingRows(orgId, candidateId, otherId, db) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM transactions t1
       JOIN transactions t2
         ON t2.org_id = t1.org_id
        AND t2.data_source_id = $3
        AND t2.date = t1.date
        AND t2.customer_id IS NOT DISTINCT FROM t1.customer_id
        AND t2.product_id IS NOT DISTINCT FROM t1.product_id
        AND t2.net_revenue = t1.net_revenue
      WHERE t1.org_id = $1 AND t1.data_source_id = $2`,
    [orgId, candidateId, otherId]
  );
  return rows[0]?.n ?? 0;
}

/** Called right before a source is switched on. Compares it against every
 *  *other* source that is already active for the org and reports any that
 *  overlap in date range along with how many rows look like exact
 *  duplicates. An empty `overlaps` array means it's safe to activate
 *  without asking the user anything. */
export async function checkActivationOverlap(orgId, candidateId, currentlyActiveIds, db = pool) {
  const others = currentlyActiveIds.filter((id) => id !== candidateId);
  if (!others.length) return { overlaps: [] };

  const candidateRange = await dateRangeOf(orgId, candidateId, db);
  if (!candidateRange) return { overlaps: [] }; // nothing imported yet — nothing to compare

  const overlaps = [];
  for (const otherId of others) {
    const otherRange = await dateRangeOf(orgId, otherId, db);
    if (!otherRange || !rangesOverlap(candidateRange, otherRange)) continue;
    const duplicateRowCount = await countMatchingRows(orgId, candidateId, otherId, db);
    const { rows } = await db.query(`SELECT name FROM data_sources WHERE id = $1`, [otherId]);
    overlaps.push({
      dataSourceId: otherId,
      name: rows[0]?.name ?? null,
      dateRange: { from: otherRange.min, to: otherRange.max },
      duplicateRowCount,
    });
  }
  return { overlaps };
}
