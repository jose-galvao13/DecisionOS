/* ---------------------------------------------------------------
   WORKER — FASE 8 ("Worker para processamento pesado"). Claims and
   processes jobs from the `jobs` table (see services/jobQueue.js).

   Runs two ways:
   1. In-process, started by server.js on boot (startWorker()) — the
      default, zero-extra-deployment setup for a single instance.
   2. As its own process (`npm run worker`, see bottom of this file)
      once you want import/refresh work off the API instance
      entirely — same code, same DB, same `jobs` table, no changes
      needed, because claimNextJob() uses `FOR UPDATE SKIP LOCKED`.

   Pipeline per job (matches the roadmap diagram):
     queued -> importing -> validating -> analytics -> completed
----------------------------------------------------------------*/
import { pool } from "./db/pool.js";
import { claimNextJob, updateJobProgress, completeJob, failJob } from "./services/jobQueue.js";
import { getStaging, clearStaging } from "./services/staging.js";
import { assessQuality } from "./services/dataQuality.js";
import { importRows } from "./services/unifiedModel.js";
import * as pgConnector from "./services/pgConnector.js";
import { decryptJSON } from "./utils/crypto.js";
import { writeAudit } from "./audit/auditLog.js";
import { invalidateOrgAnalyticsCache } from "./services/analyticsEngine.js";
import { setActiveDataSource } from "./services/activeSource.js";
import { MAX_IMPORT_ROWS } from "./config/limits.js";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS || 1500);

async function saveQualityReport(orgId, dataSourceId, quality) {
  const { randomUUID } = await import("crypto");
  await pool.query(
    `INSERT INTO data_quality_reports (id, org_id, data_source_id, score, issues) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), orgId, dataSourceId, quality.score, JSON.stringify(quality.issues)]
  );
}

async function markSourceError(dataSourceId) {
  await pool.query("UPDATE data_sources SET status = 'error' WHERE id = $1", [dataSourceId]).catch(() => {});
}

/** rows already in hand (excel staging) — assess, import, report. */
async function runImport(job, { orgId, dataSourceId, rows, mapping }) {
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(
      `dataset has ${rows.length} rows, which is over the ${MAX_IMPORT_ROWS} row limit for a single import — ` +
        `split the file or contact support to raise the limit for this organization`
    );
  }

  await updateJobProgress(job.id, { stage: "validating", progress: 10 });
  const quality = assessQuality(rows, mapping);

  await updateJobProgress(job.id, { stage: "importing", progress: 20 });
  const result = await importRows({
    orgId,
    dataSourceId,
    rows,
    mapping,
    onProgress: (imported, total) => {
      const pct = 20 + Math.round((imported / Math.max(total, 1)) * 60); // importing spans 20%..80%
      updateJobProgress(job.id, { stage: "importing", progress: Math.min(pct, 80) }).catch(() => {});
    },
  });

  await updateJobProgress(job.id, { stage: "analytics", progress: 90 });
  await saveQualityReport(orgId, dataSourceId, quality);
  // A freshly imported file/source becomes the one the app shows. A refresh
  // of an existing source keeps whichever source the user has active.
  if (job.type !== "refresh_postgres") await setActiveDataSource(orgId, dataSourceId);
  invalidateOrgAnalyticsCache(orgId); // next dashboard/advisor/decisions call recomputes from the new data

  return { ...result, dataQuality: { score: quality.score, issues: quality.issues } };
}

async function processImportExcel(job) {
  const { org_id: orgId, data_source_id: dataSourceId } = job;
  const { stagingId, mapping } = job.payload || {};
  const staged = getStaging(stagingId, orgId);
  if (!staged) throw new Error("staging expired or not found — re-upload the file");
  try {
    const result = await runImport(job, { orgId, dataSourceId, rows: staged.rows, mapping });
    await writeAudit({
      orgId, userId: job.created_by, action: "data_source.imported",
      objectType: "data_source", objectId: dataSourceId,
      after: { type: "excel", imported: result.imported, skipped: result.skipped },
    });
    return result;
  } finally {
    clearStaging(stagingId);
  }
}

async function processImportOrRefreshPostgres(job, { isRefresh }) {
  const { org_id: orgId, data_source_id: dataSourceId } = job;
  const { rows: sourceRows } = await pool.query(`SELECT * FROM data_sources WHERE id = $1 AND org_id = $2`, [dataSourceId, orgId]);
  const source = sourceRows[0];
  if (!source) throw new Error("data source not found");

  await updateJobProgress(job.id, { stage: "connecting", progress: 5 });
  const config = decryptJSON(source.connection_config);
  await pgConnector.testConnection(config);

  await updateJobProgress(job.id, { stage: "fetching", progress: 10 });
  const rows = await pgConnector.fetchAllRows(config, source.source_schema, source.source_table);
  if (!rows.length) throw new Error("that table returned no rows");

  const mapping = source.column_mapping;
  const result = await runImport(job, { orgId, dataSourceId, rows, mapping });
  await writeAudit({
    orgId, userId: job.created_by,
    action: isRefresh ? "data_source.refreshed" : "data_source.connected",
    objectType: "data_source", objectId: dataSourceId,
    after: { type: "postgres", schema: source.source_schema, table: source.source_table, imported: result.imported },
  });
  return result;
}

async function processJob(job) {
  switch (job.type) {
    case "import_excel":
      return processImportExcel(job);
    case "import_postgres":
      return processImportOrRefreshPostgres(job, { isRefresh: false });
    case "refresh_postgres":
      return processImportOrRefreshPostgres(job, { isRefresh: true });
    default:
      throw new Error(`unknown job type: ${job.type}`);
  }
}

/** Claim and run at most one job. Exported separately from the polling
 *  loop so tests can call it deterministically without a setInterval. */
export async function runOnce() {
  const job = await claimNextJob();
  if (!job) return null;
  try {
    const result = await processJob(job);
    await completeJob(job.id, result);
  } catch (e) {
    console.error(`[worker] job ${job.id} (${job.type}) failed:`, e.message);
    await failJob(job.id, e);
    if (job.data_source_id) await markSourceError(job.data_source_id);
  }
  return job;
}

let timer = null;

/** Starts the poll loop. Called from server.js by default; also the entry
 *  point when this file is run directly as its own worker process. */
export function startWorker() {
  if (timer) return;
  console.log(`[worker] polling for jobs every ${POLL_INTERVAL_MS}ms`);
  const tick = async () => {
    try {
      let job;
      // Drain the queue on each tick instead of one job per interval, so a
      // burst of imports doesn't queue up behind the poll delay.
      do {
        job = await runOnce();
      } while (job);
    } catch (e) {
      console.error("[worker] poll tick failed:", e.message);
    } finally {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };
  timer = setTimeout(tick, 0);
}

export function stopWorker() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// Allow `node src/worker.js` (or `npm run worker`) as a standalone process,
// separate from the API — see file header.
if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker();
}
