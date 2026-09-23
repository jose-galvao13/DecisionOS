/* ---------------------------------------------------------------
   PRICE HISTORY / RISK ROUTES — Parte 2, FASE 3 ("Risco com histórico
   de preços"). Mounted at the same /api/portfolio prefix as
   portfolio.routes.js (a separate router file, not a separate prefix —
   same reasoning as that file's own header comment about small,
   focused modules).

   Flow, mirroring portfolio.routes.js's own preview/commit shape:
     POST /price-history/preview  (upload+parse+suggest mapping)
     POST /price-history/commit   (enqueues an `import_price_history` job)
     POST /price-history/fetch    (optional API path — services/marketData.js)
     GET  /risk                   (services/riskAnalytics.js over whatever
                                    price_history has, cached)
----------------------------------------------------------------*/
import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { requireAuth, requireMinRole } from "../auth/middleware.js";
import { analyzeDataset } from "../data-understanding/index.js";
import { putStaging, getStaging } from "../services/staging.js";
import { validateRows, importPriceHistory } from "../services/priceHistoryImport.js";
import { fetchPrices } from "../services/marketData.js";
import { buildRiskAnalytics, invalidateRiskAnalyticsCache } from "../services/riskAnalytics.js";
import { writeAudit } from "../audit/auditLog.js";
import { enqueueJob } from "../services/jobQueue.js";
import { MAX_IMPORT_ROWS } from "../config/limits.js";
import { getCached, setCached } from "../services/cache.js";

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const RISK_CACHE_TTL_MS = 5 * 60 * 1000;

/** Same shape jobToJson() in portfolio.routes.js/datasources.routes.js
 *  returns — kept duplicated on purpose (see that file's own comment on
 *  the same function): this file has no import-time dependency on either. */
function jobToJson(job) {
  return {
    jobId: job.id,
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

/** Same "first non-empty row is the header" reader as portfolio.routes.js's
 *  tableFromSheet — duplicated rather than shared for the same reason. */
function tableFromSheet(aoa) {
  const headerRowIdx = aoa.findIndex((r) => (r || []).some((c) => c != null && String(c).trim() !== ""));
  if (headerRowIdx === -1) return { headers: [], rows: [] };
  const rawHeaders = aoa[headerRowIdx] || [];
  const keepIdx = [];
  const headers = [];
  rawHeaders.forEach((h, i) => {
    const name = h == null ? "" : String(h).trim();
    if (name) { keepIdx.push(i); headers.push(name); }
  });
  const rows = aoa
    .slice(headerRowIdx + 1)
    .filter((r) => (r || []).some((c) => c != null && String(c).trim() !== ""))
    .map((r) => {
      const obj = {};
      keepIdx.forEach((srcIdx, j) => { obj[headers[j]] = r[srcIdx] ?? null; });
      return obj;
    });
  return { headers, rows };
}

// Step 1: upload -> parse -> preview + suggested mapping (nothing written yet)
router.post("/price-history/preview", requireMinRole("manager"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required (multipart field 'file')" });
  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
  } catch {
    return res.status(400).json({ error: "could not read this file — is it a valid .xlsx/.xls/.csv?" });
  }
  const sheetName = workbook.SheetNames[0];
  const aoa = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: null });
  const { headers, rows } = tableFromSheet(aoa);
  if (!headers.length) return res.status(400).json({ error: "no header row found in this sheet" });
  if (!rows.length) return res.status(400).json({ error: "the sheet appears to be empty" });
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({
      error: `this sheet has ${rows.length} rows, which is over the ${MAX_IMPORT_ROWS} row limit for a single import — split the file into smaller uploads`,
      limit: MAX_IMPORT_ROWS,
      rowCount: rows.length,
    });
  }

  const stagingId = putStaging({ orgId: req.user.orgId, headers, rows });
  // Same engine as the holdings preview (data-understanding/index.js):
  // ticker/data/fecho are recognized via TICKER/DATE/CLOSE_PRICE in
  // semanticTypes.js.
  const analysis = analyzeDataset(headers, rows);
  const suggestedMapping = analysis.suggestedMapping;
  const { issues, stats } = validateRows(rows, suggestedMapping);

  res.json({
    stagingId,
    sheetName,
    headers,
    rowCount: rows.length,
    sampleRows: rows.slice(0, 20),
    suggestedMapping,
    unknownFields: analysis.unknownFields,
    issues,
    stats,
  });
});

// Step 2: confirm/edit mapping -> commit. Enqueues an `import_price_history`
// job (worker.js) and returns 202 immediately, same polling pattern as
// every other import in this app (GET /api/datasources/jobs/:jobId).
router.post("/price-history/commit", requireMinRole("manager"), async (req, res) => {
  const { stagingId, mapping } = req.body || {};
  if (!stagingId || !mapping) return res.status(400).json({ error: "stagingId and mapping are required" });
  if (!mapping.ticker || !mapping.date || !mapping.close_price) {
    return res.status(400).json({ error: "mapping must include 'ticker', 'date' and 'close_price'" });
  }
  const staged = getStaging(stagingId, req.user.orgId);
  if (!staged) return res.status(410).json({ error: "staging expired or not found — re-upload the file" });
  if (staged.rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `this dataset has ${staged.rows.length} rows, over the ${MAX_IMPORT_ROWS} row limit`, limit: MAX_IMPORT_ROWS });
  }

  try {
    const job = await enqueueJob({
      orgId: req.user.orgId, type: "import_price_history",
      payload: { stagingId, mapping }, createdBy: req.user.id,
    });
    res.status(202).json(jobToJson(job));
  } catch (e) {
    console.error("[/api/portfolio/price-history/commit]", e);
    res.status(500).json({ error: "could not queue import" });
  }
});

/** Distinct tickers this org has either held or already has history for —
 *  the default universe for GET /risk and for POST /price-history/fetch
 *  when the caller doesn't name specific tickers. */
async function defaultTickers(orgId) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ticker FROM (
       SELECT ticker FROM holdings WHERE org_id = $1
       UNION
       SELECT ticker FROM price_history WHERE org_id = $1
     ) t ORDER BY ticker`,
    [orgId]
  );
  return rows.map((r) => r.ticker);
}

// Ponto 3: "API opcional (services/marketData.js) ... se falhar, cai para
// dados manuais, sem partir nada." This endpoint is the "try the API"
// step: it fetches whatever it can and writes it into price_history
// (origem 'api'); tickers the provider couldn't return are reported back
// as `failed`, but nothing about the request fails because of them — the
// org still has whatever manual/uploaded history it already had.
router.post("/price-history/fetch", requireMinRole("manager"), async (req, res) => {
  const orgId = req.user.orgId;
  let tickers = Array.isArray(req.body?.tickers) && req.body.tickers.length
    ? req.body.tickers.map((t) => String(t).trim().toUpperCase()).filter(Boolean)
    : await defaultTickers(orgId);
  tickers = [...new Set(tickers)];
  if (!tickers.length) return res.json({ imported: {}, failed: {} });

  const { results, errors } = await fetchPrices(tickers);

  const imported = {};
  for (const [ticker, series] of Object.entries(results)) {
    if (!series.length) continue;
    const rows = series.map((p) => ({ Ticker: ticker, Data: p.data, Fecho: p.fecho }));
    const result = await importPriceHistory({
      orgId, rows, mapping: { ticker: "Ticker", date: "Data", close_price: "Fecho" }, createdBy: req.user.id,
    });
    // The rows above are already well-formed, but importPriceHistory still
    // validates them (Fecho > 0, a parseable Data) — surface anything it
    // skipped instead of silently claiming success for those days too.
    imported[ticker] = { imported: result.imported, skipped: result.skipped };
  }
  // Re-tag rows just written by this call as 'api' provenance — the shared
  // import path above defaults new rows to 'upload' (its normal caller is
  // the Excel commit route), so this corrects that for the fetch path only,
  // without a second bespoke insert path to keep in sync.
  if (Object.keys(imported).length) {
    await pool.query(
      `UPDATE price_history SET origem = 'api' WHERE org_id = $1 AND ticker = ANY($2)
         AND created_at > now() - interval '1 minute'`,
      [orgId, Object.keys(imported)]
    );
  }

  await writeAudit({
    orgId, userId: req.user.id, action: "price_history.fetched_from_api",
    objectType: "price_history", after: { imported: Object.keys(imported), failed: Object.keys(errors) },
  });
  invalidateRiskAnalyticsCache(orgId);
  res.json({ imported, failed: errors });
});

// Ponto 4: "separador Risco com tabela de volatilidade, heatmap de
// correlações e curva de drawdown." Pure computation from whatever
// price_history has (services/riskAnalytics.js), cached per org+index
// for a few minutes (a price-history import or API fetch invalidates it
// explicitly — see above and worker.js — rather than waiting out the TTL).
router.get("/risk", async (req, res) => {
  const orgId = req.user.orgId;
  const indexTicker = req.query.index ? String(req.query.index).trim().toUpperCase() : null;
  const requestedTickers = req.query.tickers
    ? String(req.query.tickers).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)
    : null;

  const cacheKey = `portfolio-risk:${orgId}:${indexTicker || ""}:${(requestedTickers || []).sort().join(",")}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return res.json(cached);

  let tickers = requestedTickers && requestedTickers.length ? [...requestedTickers] : await defaultTickers(orgId);
  if (indexTicker && !tickers.includes(indexTicker)) tickers.push(indexTicker);

  if (!tickers.length) {
    const empty = { minObservations: undefined, indexTicker, tickers: [], perTicker: {}, correlationMatrix: {} };
    return res.json(empty);
  }

  const { rows } = await pool.query(
    `SELECT ticker, to_char(data, 'YYYY-MM-DD') AS data, fecho
       FROM price_history
      WHERE org_id = $1 AND ticker = ANY($2)
      ORDER BY ticker, data ASC`,
    [orgId, tickers]
  );

  const seriesByTicker = {};
  for (const t of tickers) seriesByTicker[t] = [];
  for (const r of rows) seriesByTicker[r.ticker].push({ data: r.data, fecho: Number(r.fecho) });

  const analytics = buildRiskAnalytics(seriesByTicker, { indexTicker });
  setCached(cacheKey, analytics, RISK_CACHE_TTL_MS);
  res.json(analytics);
});

// Remove one ticker's history entirely (e.g. re-uploading from scratch,
// or dropping an index series that's no longer wanted). Independent of
// any one import, same as security_prices — there's no "import" object
// to delete here, just the rows for that ticker.
router.delete("/price-history/:ticker", requireMinRole("manager"), async (req, res) => {
  const ticker = String(req.params.ticker || "").trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: "ticker is required" });
  const { rowCount } = await pool.query(`DELETE FROM price_history WHERE org_id = $1 AND ticker = $2`, [req.user.orgId, ticker]);
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "price_history.deleted",
    objectType: "price_history", objectId: ticker, before: { rows: rowCount },
  });
  invalidateRiskAnalyticsCache(req.user.orgId);
  res.json({ deleted: true, rows: rowCount });
});

export default router;
