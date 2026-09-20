import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { requireAuth, requireMinRole } from "../auth/middleware.js";
import { discoverTables, materializeTable } from "../data-understanding/structureDiscovery.js";
import { analyzeDataset } from "../data-understanding/index.js";
import { analyzeWorkbook } from "../data-understanding/workbook.js";
import { putStaging, getStaging } from "../services/staging.js";
import { assessQuality } from "../services/dataQuality.js";
import * as pgConnector from "../services/pgConnector.js";
import { encryptJSON } from "../utils/crypto.js";
import { writeAudit } from "../audit/auditLog.js";
import { enqueueJob, getJob, listJobsForSource } from "../services/jobQueue.js";
import { MAX_IMPORT_ROWS } from "../config/limits.js";
import { getActiveDataSourceId, setActiveDataSource } from "../services/activeSource.js";
import { invalidateOrgAnalyticsCache } from "../services/analyticsEngine.js";

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/** Shape a job row for the API response — the frontend polls this while a
 *  progress bar renders, so keep it small and camelCase. */
function jobToJson(job) {
  return {
    jobId: job.id,
    dataSourceId: job.data_source_id,
    type: job.type,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error || null,
    result: job.result || null,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

function parsePagination(query, defaultLimit = 20) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || defaultLimit, 1), 100);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

/* ============================== EXCEL ============================== */
// Step 1: upload -> parse -> preview + suggested mapping (nothing written yet)
router.post("/excel/preview", requireMinRole("manager"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required (multipart field 'file')" });
  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
  } catch (e) {
    return res.status(400).json({ error: "could not read this file — is it a valid .xlsx/.xls/.csv?" });
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  // Raw cells first (no assumed header row) — Structure Discovery decides
  // where the table actually starts (ponto "Structure Discovery antes de
  // tudo"): title rows, blank rows, and a trailing totals row are found
  // and excluded before any profiling/semantic work ever sees them.
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
  const { tables } = discoverTables(aoa);
  if (!tables.length) {
    return res.status(400).json({ error: "no recognizable table found in this sheet (structure discovery found no header+data pattern)" });
  }
  // This endpoint predates multi-table sheets; keep it single-table for
  // backward compatibility by picking the largest table found. Full
  // multi-table exposure is /excel/analyze below.
  const table = tables.reduce((best, t) => (t.dataRowIdxs.length > best.dataRowIdxs.length ? t : best));
  const { headers, rows } = materializeTable(aoa, table);
  if (!rows.length) return res.status(400).json({ error: "the sheet appears to be empty" });
  // FASE 8 "Dataset limits claros": rejected clearly and immediately at
  // preview time, not silently truncated later during import.
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({
      error: `this sheet has ${rows.length} rows, which is over the ${MAX_IMPORT_ROWS} row limit for a single import — split the file into smaller uploads`,
      limit: MAX_IMPORT_ROWS,
      rowCount: rows.length,
    });
  }

  const stagingId = putStaging({ orgId: req.user.orgId, headers, rows });
  // Same engine as /excel/analyze (ponto 1 do documento: "só um engine") —
  // this endpoint just exposes the lighter, backward-compatible shape
  // (suggestedMapping + dataQuality) that existing clients already expect.
  const analysis = analyzeDataset(headers, rows);
  const suggestedMapping = analysis.suggestedMapping;
  const quality = assessQuality(rows, suggestedMapping);

  res.json({
    stagingId,
    sheetName,
    headers,
    rowCount: rows.length,
    sampleRows: rows.slice(0, 20),
    suggestedMapping,
    dataQuality: { score: quality.score, issues: quality.issues },
    structure: { titleRowsSkipped: table.titleRows.length, totalsRowsExcluded: table.totalsRowIdxs.length, otherTablesInSheet: tables.length - 1 },
  });
});

// Step 1b (new, additive — does not replace /excel/preview above): full
// pipeline across EVERY sheet — Structure Discovery (finds title/blank/
// totals rows and even multiple tables per sheet) -> Profiling -> Semantic
// Understanding -> Confidence -> Relationship Detection across tables,
// regardless of which sheet they came from. Each discovered table is
// staged independently so the existing /excel/commit (unchanged) can
// import any of them by stagingId, one at a time, exactly like a
// single-sheet upload already did.
router.post("/excel/analyze", requireMinRole("manager"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required (multipart field 'file')" });
  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
  } catch (e) {
    return res.status(400).json({ error: "could not read this file — is it a valid .xlsx/.xls/.csv?" });
  }

  const sheetsAoa = {};
  for (const name of workbook.SheetNames) {
    sheetsAoa[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: null });
  }

  const workbookAnalysis = analyzeWorkbook(sheetsAoa);

  // Stage every discovered table independently (even ambiguous ones — the
  // "?" flag is a suggestion for the user to confirm, not a hard block).
  const tables = workbookAnalysis.tables.map((t) => {
    const stagingId = t.rows.length ? putStaging({ orgId: req.user.orgId, headers: t.headers, rows: t.rows }) : null;
    return { ...t, stagingId, sampleRows: t.rows.slice(0, 20), rows: undefined }; // don't ship every raw row over the wire, just the sample
  });

  res.json({
    sheets: workbookAnalysis.sheets, // per-sheet structural summary: how many tables were found, unparsed leftover rows
    tables, // per-table: sheetName, tableIndex, name, structure (titleRowCount/totalsRowCount), analysis (fields/suggestedMapping/unknownFields), stagingId
    relationships: workbookAnalysis.relationships,
    summary: workbookAnalysis.summary,
  });
});

// Step 2: user confirms/edits mapping -> commit into the Unified Data Model.
// FASE 8: this used to import synchronously inside the request; it now
// creates the data_source row, enqueues an `import_excel` job, and returns
// 202 immediately. The worker (src/worker.js) does the actual import —
// poll GET /api/datasources/jobs/:jobId for progress (see roadmap diagram:
// POST /sync -> Job #id -> Worker -> Import -> Validation -> Analytics -> Completed).
router.post("/excel/commit", requireMinRole("manager"), async (req, res) => {
  const { stagingId, mapping, name } = req.body || {};
  if (!stagingId || !mapping) return res.status(400).json({ error: "stagingId and mapping are required" });
  if (!mapping.date || !mapping.revenue) {
    return res.status(400).json({ error: "mapping must at least include 'date' and 'revenue'" });
  }
  const staged = getStaging(stagingId, req.user.orgId);
  if (!staged) return res.status(410).json({ error: "staging expired or not found — re-upload the file" });
  if (staged.rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `this dataset has ${staged.rows.length} rows, over the ${MAX_IMPORT_ROWS} row limit`, limit: MAX_IMPORT_ROWS });
  }

  const dataSourceId = randomUUID();
  try {
    await pool.query(
      `INSERT INTO data_sources (id, org_id, name, type, status, column_mapping, created_by)
       VALUES ($1,$2,$3,'excel','syncing',$4,$5)`,
      [dataSourceId, req.user.orgId, name || "Excel upload", JSON.stringify(mapping), req.user.id]
    );
    const job = await enqueueJob({
      orgId: req.user.orgId, dataSourceId, type: "import_excel",
      payload: { stagingId, mapping }, createdBy: req.user.id,
    });
    res.status(202).json({ dataSourceId, ...jobToJson(job) });
  } catch (e) {
    console.error("[/api/datasources/excel/commit]", e);
    await pool.query("UPDATE data_sources SET status = 'error' WHERE id = $1", [dataSourceId]).catch(() => {});
    res.status(500).json({ error: "could not queue import" });
  }
});

/* ============================ POSTGRESQL ============================ */
// The wizard from the roadmap: Test Connection -> Select Database (the
// `database` field of config) -> Select Schema -> Select Tables -> Preview
// -> Map Columns -> Validate -> Import/Connect -> Unified Data Model.
// `config` is always { host, port, database, user, password, ssl } for the
// CUSTOMER's own Postgres and is never persisted until /commit.

router.post("/postgres/test", requireMinRole("admin"), async (req, res) => {
  try {
    await pgConnector.testConnection(req.body?.config || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/postgres/schemas", requireMinRole("admin"), async (req, res) => {
  try {
    res.json({ schemas: await pgConnector.listSchemas(req.body?.config || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/postgres/tables", requireMinRole("admin"), async (req, res) => {
  const { config, schema } = req.body || {};
  if (!schema) return res.status(400).json({ error: "schema is required" });
  try {
    res.json({ tables: await pgConnector.listTables(config || {}, schema) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/postgres/preview", requireMinRole("admin"), async (req, res) => {
  const { config, schema, table } = req.body || {};
  if (!schema || !table) return res.status(400).json({ error: "schema and table are required" });
  try {
    const { headers, rows } = await pgConnector.previewTable(config || {}, schema, table, 20);
    const analysis = rows.length ? analyzeDataset(headers, rows) : { suggestedMapping: {}, fields: [], unknownFields: headers, summary: { auto: 0, review: 0, unknown: headers.length } };
    const suggestedMapping = analysis.suggestedMapping;
    const quality = rows.length ? assessQuality(rows, suggestedMapping) : { score: null, issues: [] };
    res.json({ headers, sampleRows: rows, suggestedMapping, dataQuality: quality, fields: analysis.fields, unknownFields: analysis.unknownFields });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// FASE 8: connect + fetch-all-rows + import used to happen synchronously
// inside this request (the heaviest step, `fetchAllRows`, could take
// minutes on a big table). It now only validates the connection quickly,
// persists the data source, and hands the actual fetch/import off to the
// worker as an `import_postgres` job — same 202 + poll pattern as excel.
router.post("/postgres/commit", requireMinRole("admin"), async (req, res) => {
  const { config, schema, table, mapping, name } = req.body || {};
  if (!config || !schema || !table || !mapping) {
    return res.status(400).json({ error: "config, schema, table and mapping are required" });
  }
  if (!mapping.date || !mapping.revenue) {
    return res.status(400).json({ error: "mapping must at least include 'date' and 'revenue'" });
  }
  const dataSourceId = randomUUID();
  try {
    await pgConnector.testConnection(config); // fast fail here, not after the row fetch
    await pool.query(
      `INSERT INTO data_sources
         (id, org_id, name, type, status, connection_config, source_schema, source_table, column_mapping, created_by)
       VALUES ($1,$2,$3,'postgres','syncing',$4,$5,$6,$7,$8)`,
      [dataSourceId, req.user.orgId, name || `${schema}.${table}`, encryptJSON(config), schema, table, JSON.stringify(mapping), req.user.id]
    );
    const job = await enqueueJob({ orgId: req.user.orgId, dataSourceId, type: "import_postgres", createdBy: req.user.id });
    res.status(202).json({ dataSourceId, ...jobToJson(job) });
  } catch (e) {
    console.error("[/api/datasources/postgres/commit]", e);
    await pool.query("UPDATE data_sources SET status = 'error' WHERE id = $1", [dataSourceId]).catch(() => {});
    res.status(400).json({ error: e.message || "connect failed" });
  }
});

/* ============================== SHARED ============================== */
// FASE 8 "Paginação" — orgs accumulate data sources over time (one per
// upload/connection); ?limit & ?offset keep this bounded instead of
// growing the response forever. Defaults preserve old behavior for
// existing callers that don't pass either param.
router.get("/", async (req, res) => {
  const { limit, offset } = parsePagination(req.query, 50);
  const { rows } = await pool.query(
    `SELECT id, name, type, status, source_schema, source_table, row_count, last_sync_at, created_at
     FROM data_sources WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [req.user.orgId, limit, offset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM data_sources WHERE org_id = $1`, [req.user.orgId]);
  // Which of them the dashboards are currently built from (see services/activeSource.js).
  const activeId = await getActiveDataSourceId(req.user.orgId);
  res.json({
    dataSources: rows.map((r) => ({ ...r, is_active: r.id === activeId })),
    total: Number(countRows[0].count),
    limit,
    offset,
  });
});

// Switch which file/source the whole organization looks at. Only sources
// that actually finished importing can be chosen.
router.post("/:id/activate", requireMinRole("manager"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, type, status, row_count FROM data_sources WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.user.orgId]
  );
  if (!rows.length) return res.status(404).json({ error: "data source not found" });
  const source = rows[0];
  if (source.status !== "connected" || !(Number(source.row_count) > 0)) {
    return res.status(409).json({ error: "this data source has no imported data — finish or retry the import first" });
  }
  const before = await getActiveDataSourceId(req.user.orgId);
  await setActiveDataSource(req.user.orgId, source.id);
  invalidateOrgAnalyticsCache(req.user.orgId); // next dashboard/advisor call recomputes from this file
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "data_source.activated",
    objectType: "data_source", objectId: source.id,
    before: { activeDataSourceId: before }, after: { activeDataSourceId: source.id, name: source.name },
  });
  res.json({ dataSourceId: source.id, active: true });
});

// Remove a file/source and everything imported from it (transactions,
// quality reports and job history go with it via ON DELETE CASCADE). If it
// was the active one, the app falls back to the newest remaining source.
router.delete("/:id", requireMinRole("manager"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, type, status, row_count FROM data_sources WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.user.orgId]
  );
  if (!rows.length) return res.status(404).json({ error: "data source not found" });
  const source = rows[0];
  await pool.query(`DELETE FROM data_sources WHERE id = $1 AND org_id = $2`, [source.id, req.user.orgId]);
  invalidateOrgAnalyticsCache(req.user.orgId);
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "data_source.deleted",
    objectType: "data_source", objectId: source.id,
    before: { name: source.name, type: source.type, rowCount: Number(source.row_count) },
  });
  res.json({ deleted: true, activeDataSourceId: await getActiveDataSourceId(req.user.orgId) });
});

// FASE 8 progress polling — the frontend calls this every ~1.5s while a
// job is queued/running and stops once status is completed/failed.
router.get("/jobs/:jobId", async (req, res) => {
  const job = await getJob(req.params.jobId, req.user.orgId);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(jobToJson(job));
});

// FASE 7's "Sync history" tab, unblocked: paginated job history per source.
router.get("/:id/jobs", async (req, res) => {
  const { limit, offset } = parsePagination(req.query, 20);
  const { jobs, total } = await listJobsForSource(req.user.orgId, req.params.id, { limit, offset });
  res.json({ jobs: jobs.map(jobToJson), total, limit, offset });
});

router.get("/:id/quality", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT score, issues, created_at FROM data_quality_reports
     WHERE org_id = $1 AND data_source_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [req.user.orgId, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "no data quality report for this source yet" });
  res.json(rows[0]);
});

// "Refresh now" — for db-type sources this re-runs the same schema.table +
// mapping query against the live source; excel sources have no file to
// re-read (we don't keep the original upload) and must be re-uploaded.
// FASE 8: enqueues a `refresh_postgres` job instead of blocking the
// request on a potentially large re-fetch + re-import. Returns 202 +
// jobId; poll GET /api/datasources/jobs/:jobId for progress.
router.post("/:id/refresh", requireMinRole("manager"), async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM data_sources WHERE id = $1 AND org_id = $2`, [req.params.id, req.user.orgId]);
  if (!rows.length) return res.status(404).json({ error: "data source not found" });
  const source = rows[0];
  if (source.type === "excel") {
    return res.status(400).json({ error: "excel sources can't auto-refresh — upload the updated file via /excel/preview + /excel/commit" });
  }
  if (source.status === "syncing") {
    // A prior job for this source hasn't finished — avoid two workers
    // racing to DELETE+INSERT the same data_source_id's transactions.
    return res.status(409).json({ error: "a sync is already in progress for this data source" });
  }
  await pool.query("UPDATE data_sources SET status = 'syncing' WHERE id = $1", [source.id]);
  const job = await enqueueJob({ orgId: req.user.orgId, dataSourceId: source.id, type: "refresh_postgres", createdBy: req.user.id });
  res.status(202).json(jobToJson(job));
});

export default router;
