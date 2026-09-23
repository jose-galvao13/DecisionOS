/* ---------------------------------------------------------------
   PORTFOLIO ROUTES — Parte 2, FASE 1 ("Carteira por upload").

   Flow: POST /preview (upload+parse+suggest mapping, nothing written) ->
   POST /commit (creates/updates a portfolio_imports row, enqueues an
   `import_portfolio` job, returns 202) -> worker.js does the actual
   import -> GET /api/datasources/jobs/:jobId (existing, reused as-is —
   it only checks org_id, not which route created the job) polls progress,
   same pattern as excel/postgres imports in datasources.routes.js.
----------------------------------------------------------------*/
import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { requireAuth, requireMinRole } from "../auth/middleware.js";
import { analyzeDataset } from "../data-understanding/index.js";
import { putStaging, getStaging } from "../services/staging.js";
import { validateRows } from "../services/portfolioImport.js";
import { parseDate } from "../utils/parse.js";
import { writeAudit } from "../audit/auditLog.js";
import { enqueueJob } from "../services/jobQueue.js";
import { MAX_IMPORT_ROWS } from "../config/limits.js";

const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Same small shape jobToJson() in datasources.routes.js returns — kept
 *  duplicated rather than shared so this file has no import-time
 *  dependency on that one; the frontend already knows this shape from
 *  polling excel/postgres imports. */
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

/** Turns a raw worksheet (array-of-arrays) into headers + row objects.
 *  Deliberately simpler than datasources.routes.js's structure discovery
 *  (title rows / multi-table sheets): a holdings export is a single small
 *  table with a header row, so "first non-empty row is the header, the
 *  rest are data" is enough here. Blank header cells are dropped (and
 *  with them, that column's values) so they don't produce a "" mapping
 *  key downstream. */
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
router.post("/preview", requireMinRole("manager"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "file is required (multipart field 'file')" });
  let workbook;
  try {
    workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
  } catch (e) {
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
  // Same engine as excel/postgres previews (data-understanding/index.js):
  // ticker/quantidade/preço médio/moeda are recognized via the TICKER/
  // QUANTITY/AVG_PRICE/CURRENCY entries in semanticTypes.js.
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

// Step 2: user confirms/edits mapping -> commit. Creates the
// portfolio_imports row (or reuses `importId` for a reimport — same
// "replace, not append" semantics unifiedModel.js uses for data sources),
// enqueues an `import_portfolio` job and returns 202 immediately; the
// worker (src/worker.js) does the actual import.
router.post("/commit", requireMinRole("manager"), async (req, res) => {
  const { stagingId, mapping, name, importId } = req.body || {};
  if (!stagingId || !mapping) return res.status(400).json({ error: "stagingId and mapping are required" });
  if (!mapping.ticker || !mapping.quantity || !mapping.currency || !mapping.avg_price) {
    return res.status(400).json({ error: "mapping must at least include 'ticker', 'quantity', 'avg_price' and 'currency'" });
  }
  const staged = getStaging(stagingId, req.user.orgId);
  if (!staged) return res.status(410).json({ error: "staging expired or not found — re-upload the file" });
  if (staged.rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `this dataset has ${staged.rows.length} rows, over the ${MAX_IMPORT_ROWS} row limit`, limit: MAX_IMPORT_ROWS });
  }

  let finalImportId = importId || null;
  try {
    if (finalImportId) {
      // Reimport: same file, replace its positions. Ownership is checked
      // here (not just left to the worker) so a bad id fails the request
      // immediately instead of a 202 that then quietly errors.
      const { rows: found } = await pool.query(
        `SELECT id, name FROM portfolio_imports WHERE id = $1 AND org_id = $2`,
        [finalImportId, req.user.orgId]
      );
      if (!found.length) return res.status(404).json({ error: "portfolio import not found" });
      await pool.query(
        `UPDATE portfolio_imports SET name = $2, status = 'syncing' WHERE id = $1`,
        [finalImportId, name || found[0].name]
      );
    } else {
      finalImportId = randomUUID();
      await pool.query(
        `INSERT INTO portfolio_imports (id, org_id, name, status, created_by) VALUES ($1,$2,$3,'syncing',$4)`,
        [finalImportId, req.user.orgId, name || "Carteira importada", req.user.id]
      );
    }
    const job = await enqueueJob({
      orgId: req.user.orgId, type: "import_portfolio",
      payload: { stagingId, mapping, importId: finalImportId }, createdBy: req.user.id,
    });
    res.status(202).json({ importId: finalImportId, ...jobToJson(job) });
  } catch (e) {
    console.error("[/api/portfolio/commit]", e);
    if (finalImportId) await pool.query(`UPDATE portfolio_imports SET status = 'error' WHERE id = $1`, [finalImportId]).catch(() => {});
    res.status(500).json({ error: "could not queue import" });
  }
});

// Every uploaded portfolio file — same idea as GET /api/datasources for
// Excel/Postgres sources, so the frontend can list/rename/remove imports.
router.get("/imports", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, status, row_count, created_at FROM portfolio_imports WHERE org_id = $1 ORDER BY created_at DESC`,
    [req.user.orgId]
  );
  res.json({ imports: rows });
});

// Positions summed by ticker across every import this org has (ponto 6:
// "todas as posições de todos os ficheiros somam-se por ticker" — there is
// no concept of "which file a holding belongs to" once it's in the total).
// preco_medio here is the quantity-weighted average across every lot.
router.get("/holdings", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT h.ticker,
            SUM(h.quantidade)                                AS quantidade,
            SUM(h.quantidade * h.preco_medio) / SUM(h.quantidade) AS preco_medio,
            (ARRAY_AGG(h.moeda ORDER BY h.created_at DESC))[1]      AS moeda,
            (ARRAY_AGG(h.nome ORDER BY h.created_at DESC))[1]       AS nome,
            (ARRAY_AGG(h.sector ORDER BY h.created_at DESC))[1]     AS sector,
            (ARRAY_AGG(h.pais ORDER BY h.created_at DESC))[1]       AS pais,
            (ARRAY_AGG(h.tipo_ativo ORDER BY h.created_at DESC))[1] AS tipo_ativo,
            COUNT(DISTINCT h.import_id)                      AS file_count
       FROM holdings h
      WHERE h.org_id = $1
      GROUP BY h.ticker
      ORDER BY h.ticker`,
    [req.user.orgId]
  );

  const tickers = rows.map((r) => r.ticker);
  let latestByTicker = {};
  if (tickers.length) {
    const { rows: priceRows } = await pool.query(
      `SELECT DISTINCT ON (ticker) ticker, preco, moeda, data, origem
         FROM security_prices
        WHERE org_id = $1 AND ticker = ANY($2)
        ORDER BY ticker, data DESC, created_at DESC`,
      [req.user.orgId, tickers]
    );
    latestByTicker = Object.fromEntries(priceRows.map((p) => [p.ticker, p]));
  }

  let custoTotalSum = 0;
  let valorAtualSum = 0;
  const holdings = rows.map((r) => {
    const quantidade = Number(r.quantidade);
    const precoMedio = Number(r.preco_medio);
    const custoTotal = quantidade * precoMedio;
    const latest = latestByTicker[r.ticker];
    const precoAtual = latest ? Number(latest.preco) : null;
    const valorAtual = precoAtual != null ? quantidade * precoAtual : null;
    const ganhoPerdaAbs = valorAtual != null ? valorAtual - custoTotal : null;
    const ganhoPerdaPct = valorAtual != null && custoTotal ? (ganhoPerdaAbs / custoTotal) * 100 : null;
    custoTotalSum += custoTotal;
    valorAtualSum += valorAtual != null ? valorAtual : custoTotal; // no quote yet: treat cost as the best-known value

    return {
      ticker: r.ticker,
      nome: r.nome,
      sector: r.sector,
      pais: r.pais,
      tipoAtivo: r.tipo_ativo,
      quantidade,
      precoMedio,
      moeda: r.moeda,
      custoTotal,
      precoAtual,
      valorAtual,
      ganhoPerdaAbs,
      ganhoPerdaPct,
      fileCount: Number(r.file_count),
      lastPriceDate: latest?.data || null,
      lastPriceSource: latest?.origem || null,
    };
  });

  res.json({
    holdings,
    totals: { custoTotal: custoTotalSum, valorAtual: valorAtualSum },
  });
});

// Manual price entry (origem 'manual') for one ticker/day. Upserts on
// (org_id, ticker, data) so re-entering today's price corrects it instead
// of piling up duplicate rows for the same day.
router.put("/prices", requireMinRole("manager"), async (req, res) => {
  const { ticker, preco, moeda, data } = req.body || {};
  const t = String(ticker || "").trim().toUpperCase();
  const price = Number(preco);
  const cur = String(moeda || "").trim().toUpperCase();
  if (!t) return res.status(400).json({ error: "ticker is required" });
  if (!isFinite(price) || price <= 0) return res.status(400).json({ error: "preco must be a positive number" });
  if (!CURRENCY_RE.test(cur)) return res.status(400).json({ error: "moeda must be a 3-letter currency code, e.g. EUR" });
  const dataDia = data ? parseDate(data) : null;
  if (data && !dataDia) return res.status(400).json({ error: "data could not be parsed" });

  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO security_prices (id, org_id, ticker, preco, moeda, data, origem, created_by)
     VALUES ($1,$2,$3,$4,$5, COALESCE($6, CURRENT_DATE), 'manual', $7)
     ON CONFLICT (org_id, ticker, data)
     DO UPDATE SET preco = EXCLUDED.preco, moeda = EXCLUDED.moeda, origem = 'manual',
                    created_by = EXCLUDED.created_by, created_at = now()
     RETURNING ticker, preco, moeda, to_char(data, 'YYYY-MM-DD') AS data`,
    [id, req.user.orgId, t, price, cur, dataDia, req.user.id]
  );
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "portfolio.price_updated",
    objectType: "security_price", objectId: t, after: rows[0],
  });
  res.json(rows[0]);
});

// Remove a portfolio import and its positions (holdings cascade via
// ON DELETE CASCADE). Prices in security_prices are independent of any one
// import, so they're left alone — a ticker's quote history outlives the
// file that first introduced it.
router.delete("/:id", requireMinRole("manager"), async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, row_count FROM portfolio_imports WHERE id = $1 AND org_id = $2`,
    [req.params.id, req.user.orgId]
  );
  if (!rows.length) return res.status(404).json({ error: "portfolio import not found" });
  const imp = rows[0];
  await pool.query(`DELETE FROM portfolio_imports WHERE id = $1 AND org_id = $2`, [imp.id, req.user.orgId]);
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "portfolio_import.deleted",
    objectType: "portfolio_import", objectId: imp.id,
    before: { name: imp.name, rowCount: Number(imp.row_count) },
  });
  res.json({ deleted: true });
});

export default router;
