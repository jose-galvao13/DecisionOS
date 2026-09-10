/* ---------------------------------------------------------------
   FASE 8 — "Dataset limits claros": one place both the import path
   and the analytics path read from, so the limit is documented and
   consistent instead of a silent truncation buried in a query. When
   a source is too big we FAIL the job with a clear message rather
   than importing a silently-truncated subset of the customer's data.
----------------------------------------------------------------*/
export const MAX_IMPORT_ROWS = Number(process.env.DATASET_MAX_ROWS || 200_000);

// Analytics loads the whole org's transactions into memory to compute
// aggregates (analyticsEngine.js) — same cap, same rationale.
export const ANALYTICS_ROW_CAP = MAX_IMPORT_ROWS;
