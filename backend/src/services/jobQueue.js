/* ---------------------------------------------------------------
   JOB QUEUE — FASE 8 ("Background jobs", "Async imports", "Progress
   indicators"). Postgres-backed (see db/schema.sql `jobs` table),
   not Redis/BullMQ — this app is already Postgres end to end, and a
   `FOR UPDATE SKIP LOCKED` claim query gets you a correct queue
   without a new infra dependency. Safe for more than one worker
   process/instance: two workers polling at once can never claim the
   same row.

   Flow (matches the roadmap diagram):
     POST /sync -> enqueueJob() -> Job #id (status 'queued')
                -> worker.js claims it -> stage: importing
                -> stage: validating -> stage: analytics -> completed
----------------------------------------------------------------*/
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";

/** Create a queued job and return its row. Never throws for a bad `type` —
 *  that's a programming error the caller should have caught already. */
export async function enqueueJob({ orgId, dataSourceId = null, type, payload = {}, createdBy = null }) {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, org_id, data_source_id, type, status, stage, progress, payload, created_by)
     VALUES ($1,$2,$3,$4,'queued','queued',0,$5,$6)
     RETURNING *`,
    [id, orgId, dataSourceId, type, JSON.stringify(payload), createdBy]
  );
  return rows[0];
}

/** Atomically claim the oldest queued job so two worker loops (or two
 *  instances of this backend) never process the same job twice. */
export async function claimNextJob() {
  const { rows } = await pool.query(
    `UPDATE jobs SET status = 'running', stage = 'starting', started_at = now()
     WHERE id = (
       SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return rows[0] || null;
}

export async function updateJobProgress(id, { stage, progress }) {
  await pool.query(`UPDATE jobs SET stage = $2, progress = $3 WHERE id = $1`, [id, stage, progress]);
}

export async function completeJob(id, result) {
  await pool.query(
    `UPDATE jobs SET status = 'completed', stage = 'completed', progress = 100, result = $2, finished_at = now() WHERE id = $1`,
    [id, JSON.stringify(result ?? {})]
  );
}

export async function failJob(id, error) {
  await pool.query(
    `UPDATE jobs SET status = 'failed', stage = 'failed', error = $2, finished_at = now() WHERE id = $1`,
    [id, String(error?.message || error || "job failed")]
  );
}

/** Single job lookup, tenant-scoped — used by the polling endpoint
 *  (GET /api/datasources/jobs/:jobId). Never let one org read another's
 *  job just by guessing a UUID. */
export async function getJob(id, orgId) {
  const { rows } = await pool.query(`SELECT * FROM jobs WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return rows[0] || null;
}

/** Paginated job history for one data source — this is the "Sync history"
 *  tab in the Data Quality Center (FASE 7 left it as a documented
 *  placeholder waiting on FASE 8; this is that dependency). */
export async function listJobsForSource(orgId, dataSourceId, { limit = 20, offset = 0 } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const { rows } = await pool.query(
    `SELECT id, data_source_id, type, status, stage, progress, error, created_at, started_at, finished_at
     FROM jobs WHERE org_id = $1 AND data_source_id = $2
     ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [orgId, dataSourceId, cappedLimit, safeOffset]
  );
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*) FROM jobs WHERE org_id = $1 AND data_source_id = $2`,
    [orgId, dataSourceId]
  );
  return { jobs: rows, total: Number(countRows[0].count), limit: cappedLimit, offset: safeOffset };
}
