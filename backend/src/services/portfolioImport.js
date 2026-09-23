/* ---------------------------------------------------------------
   PORTFOLIO IMPORT — Parte 2, FASE 1 ("Carteira por upload").

   Mirrors unifiedModel.js's shape on purpose: same parse.js helpers,
   same chunked-INSERT pattern, same "delete this import's rows, then
   reinsert" replace semantics (so reimporting a file is idempotent
   instead of appending duplicate positions every time it's re-uploaded).

   mapping: { ticker, quantity, avg_price, currency, date, nome, sector,
              region, asset_type } — values are raw header names to read
   from each row (or null/undefined). `ticker`, `quantity` and `currency`
   are the required three (see routes/portfolio.routes.js /commit); the
   rest are optional and simply left null when not mapped.

   Field-name note: `ticker`/`quantity`/`avg_price`/`currency`/`date` are
   exactly the keys data-understanding/index.js's analyzeDataset()
   produces (lowercased semanticType — see semanticTypes.js's TICKER/
   AVG_PRICE/CURRENCY entries and the existing QUANTITY/DATE ones it
   reuses), so the frontend can hand analyzeDataset's suggestedMapping
   straight to /commit without renaming keys. `nome`/`sector`/`region`/
   `asset_type` have no dedicated semantic type (ponto 2 of the doc only
   asked for ticker/quantidade/preço médio/moeda) — the user maps those
   manually if the sheet has them.
----------------------------------------------------------------*/
import { randomUUID } from "crypto";
import { withTransaction } from "../db/pool.js";
import { parseDate, parseNumber } from "../utils/parse.js";

const CHUNK_SIZE = 500;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** Uppercased + trimmed, kept only when it's exactly 3 letters (ISO 4217
 *  shape) — a looser value is rejected rather than guessed at, same
 *  reasoning as the "moeda com 3 letras" validation rule in the spec. */
function readCurrency(raw) {
  const v = String(raw ?? "").trim().toUpperCase();
  return CURRENCY_RE.test(v) ? v : null;
}

/**
 * Validates raw rows against `mapping` without writing anything — used by
 * both /preview (so the person sees issues before committing) and by
 * importHoldings() below (so a row that fails here is skipped there too,
 * for exactly the same reason, instead of the two checks silently drifting
 * apart over time).
 *
 * Returns { flags, issues, stats } where `flags[i]` says whether row i is
 * importable and carries its already-parsed ticker/quantidade/moeda so
 * importHoldings() doesn't re-parse them.
 */
export function validateRows(rows, mapping) {
  const total = rows.length;
  let missingTicker = 0;
  let invalidQuantity = 0;
  let invalidCurrency = 0;

  const flags = rows.map((row) => {
    const ticker = mapping.ticker ? String(row[mapping.ticker] ?? "").trim() : "";
    const quantidade = mapping.quantity ? parseNumber(row[mapping.quantity]) : null;
    const moeda = mapping.currency ? readCurrency(row[mapping.currency]) : null;

    const tickerOk = !!ticker;
    const quantidadeOk = quantidade != null && quantidade > 0;
    const moedaOk = !!moeda;

    if (!tickerOk) missingTicker++;
    if (!quantidadeOk) invalidQuantity++;
    if (!moedaOk) invalidCurrency++;

    return { ok: tickerOk && quantidadeOk && moedaOk, ticker, quantidade, moeda };
  });

  const issues = [];
  if (missingTicker > 0) {
    issues.push({
      severity: missingTicker / total > 0.05 ? "red" : "yellow",
      code: "missing_ticker",
      message: `${missingTicker} linhas sem ticker`,
      count: missingTicker,
    });
  }
  if (invalidQuantity > 0) {
    issues.push({
      severity: invalidQuantity / total > 0.05 ? "red" : "yellow",
      code: "invalid_quantity",
      message: `${invalidQuantity} linhas com quantidade inválida (tem de ser > 0)`,
      count: invalidQuantity,
    });
  }
  if (invalidCurrency > 0) {
    issues.push({
      severity: invalidCurrency / total > 0.05 ? "red" : "yellow",
      code: "invalid_currency",
      message: `${invalidCurrency} linhas com moeda inválida (esperado código de 3 letras, ex. EUR, USD)`,
      count: invalidCurrency,
    });
  }

  const validCount = flags.filter((f) => f.ok).length;
  return { flags, issues, stats: { rows: total, valid: validCount, invalid: total - validCount } };
}

/**
 * Imports mapped raw rows into `holdings` for one portfolio import.
 * Deletes any prior holdings for that import_id first — reimporting the
 * same file replaces its positions, exactly like unifiedModel.importRows
 * does for a data source's transactions.
 */
export async function importHoldings({ orgId, importId, rows, mapping, onProgress }) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM holdings WHERE import_id = $1`, [importId]);

    const { flags } = validateRows(rows, mapping);

    let imported = 0;
    let skipped = 0;
    const values = [];

    const flush = async () => {
      if (!values.length) return;
      const cols = 12;
      const placeholders = values
        .map((_, i) => `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(",")})`)
        .join(",");
      const flat = values.flat();
      await client.query(
        `INSERT INTO holdings
           (id, import_id, org_id, ticker, nome, quantidade, preco_medio, moeda, data_compra, sector, pais, tipo_ativo)
         VALUES ${placeholders}`,
        flat
      );
      values.length = 0;
    };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const flag = flags[i];
      // Ticker/quantidade/moeda already invalid — nothing else about this
      // row matters, it can't become a position.
      if (!flag.ok) {
        skipped++;
        continue;
      }
      const precoMedio = mapping.avg_price ? parseNumber(row[mapping.avg_price]) : null;
      // Valid ticker/quantidade/moeda but no usable average price still
      // isn't a real position — dropped here rather than importing a
      // holding with a fabricated cost basis.
      if (precoMedio == null) {
        skipped++;
        continue;
      }

      const nome = mapping.nome ? String(row[mapping.nome] ?? "").trim() || null : null;
      const dataCompra = mapping.date ? parseDate(row[mapping.date]) : null;
      const sector = mapping.sector ? String(row[mapping.sector] ?? "").trim() || null : null;
      const pais = mapping.region ? String(row[mapping.region] ?? "").trim() || null : null;
      const tipoAtivo = mapping.asset_type ? String(row[mapping.asset_type] ?? "").trim() || null : null;

      values.push([
        randomUUID(), importId, orgId, flag.ticker.toUpperCase(), nome, flag.quantidade,
        precoMedio, flag.moeda, dataCompra, sector, pais, tipoAtivo,
      ]);
      imported++;
      if (values.length >= CHUNK_SIZE) {
        await flush();
        // FASE 8-style progress indicator, same as unifiedModel.js: report
        // after each flushed chunk, not every row.
        if (onProgress) onProgress(imported, rows.length);
      }
    }
    await flush();
    if (onProgress) onProgress(imported, rows.length);

    await client.query(
      `UPDATE portfolio_imports SET row_count = $2, status = 'connected' WHERE id = $1`,
      [importId, imported]
    );

    return { imported, skipped, total: rows.length };
  });
}
