/* ---------------------------------------------------------------
   PRICE HISTORY IMPORT — Parte 2, FASE 3 ("upload de séries por
   Excel: data, ticker, fecho").

   Mirrors portfolioImport.js's shape on purpose: same parse.js helpers,
   same chunked-INSERT pattern, same preview/validateRows split so
   /price-history/preview can show issues before committing. Differs in
   one way: this UPSERTs on (org_id, ticker, data) instead of delete+
   reinsert-per-import, because price_history has no "one file owns
   these rows" concept — a ticker's series can be topped up by several
   files (or services/marketData.js) over time, each contributing
   whatever dates it has, exactly like security_prices already does for
   a single day's quote.

   mapping: { ticker, date, close_price } — values are raw header names
   to read from each row. All three are required (ponto 1: "Tabela
   price_history (ticker, data, fecho)"). Field-name note: `ticker`,
   `date` and `close_price` are exactly the keys data-understanding/
   index.js's analyzeDataset() produces (see semanticTypes.js's TICKER,
   DATE and CLOSE_PRICE entries), so the frontend can hand
   suggestedMapping straight to /commit without renaming keys.
----------------------------------------------------------------*/
import { randomUUID } from "crypto";
import { withTransaction } from "../db/pool.js";
import { parseDate, parseNumber } from "../utils/parse.js";

const CHUNK_SIZE = 500;

/**
 * Validates raw rows against `mapping` without writing anything — used by
 * both /preview and importPriceHistory() below, same reasoning as
 * portfolioImport.js's validateRows: a row that fails here is skipped
 * there too, so the two checks can't silently drift apart.
 */
export function validateRows(rows, mapping) {
  const total = rows.length;
  let missingTicker = 0;
  let invalidDate = 0;
  let invalidClose = 0;

  const flags = rows.map((row) => {
    const ticker = mapping.ticker ? String(row[mapping.ticker] ?? "").trim().toUpperCase() : "";
    const date = mapping.date ? parseDate(row[mapping.date]) : null;
    const fecho = mapping.close_price ? parseNumber(row[mapping.close_price]) : null;

    const tickerOk = !!ticker;
    const dateOk = !!date;
    const fechoOk = fecho != null && fecho > 0;

    if (!tickerOk) missingTicker++;
    if (!dateOk) invalidDate++;
    if (!fechoOk) invalidClose++;

    return { ok: tickerOk && dateOk && fechoOk, ticker, date, fecho };
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
  if (invalidDate > 0) {
    issues.push({
      severity: invalidDate / total > 0.05 ? "red" : "yellow",
      code: "invalid_date",
      message: `${invalidDate} linhas com data inválida`,
      count: invalidDate,
    });
  }
  if (invalidClose > 0) {
    issues.push({
      severity: invalidClose / total > 0.05 ? "red" : "yellow",
      code: "invalid_close",
      message: `${invalidClose} linhas com preço de fecho inválido (tem de ser > 0)`,
      count: invalidClose,
    });
  }

  const validCount = flags.filter((f) => f.ok).length;
  return { flags, issues, stats: { rows: total, valid: validCount, invalid: total - validCount } };
}

/**
 * Upserts mapped raw rows into `price_history` for one org. A row that
 * repeats an existing (ticker, data) pair overwrites that day's close —
 * the last upload/import wins, same as security_prices' manual-price
 * upsert — rather than silently piling up or silently refusing.
 */
export async function importPriceHistory({ orgId, rows, mapping, createdBy, onProgress }) {
  const { flags } = validateRows(rows, mapping);

  return withTransaction(async (client) => {
    let imported = 0;
    let skipped = 0;
    const tickers = new Set();
    const values = [];

    const flush = async () => {
      if (!values.length) return;
      const cols = 7;
      const placeholders = values
        .map((_, i) => `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(",")})`)
        .join(",");
      const flat = values.flat();
      await client.query(
        `INSERT INTO price_history (id, org_id, ticker, data, fecho, origem, created_by)
         VALUES ${placeholders}
         ON CONFLICT (org_id, ticker, data)
         DO UPDATE SET fecho = EXCLUDED.fecho, origem = 'upload',
                        created_by = EXCLUDED.created_by, created_at = now()`,
        flat
      );
      values.length = 0;
    };

    for (let i = 0; i < rows.length; i++) {
      const flag = flags[i];
      if (!flag.ok) {
        skipped++;
        continue;
      }
      tickers.add(flag.ticker);
      values.push([randomUUID(), orgId, flag.ticker, flag.date, flag.fecho, "upload", createdBy]);
      imported++;
      if (values.length >= CHUNK_SIZE) {
        await flush();
        if (onProgress) onProgress(imported, rows.length);
      }
    }
    await flush();
    if (onProgress) onProgress(imported, rows.length);

    return { imported, skipped, total: rows.length, tickers: [...tickers] };
  });
}
