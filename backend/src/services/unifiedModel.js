import { randomUUID } from "crypto";
import { pool, withTransaction } from "../db/pool.js";
import { parseDate, parseNumber, normalizeKey } from "../utils/parse.js";

const CHUNK_SIZE = 500;

/** Get-or-create a dimension row (customers/products keyed by external_id;
 *  regions/channels keyed by name directly) and cache it for the rest of
 *  this import so repeated values don't round-trip to Postgres every row. */
async function dimensionResolver(client, orgId, table, keyColumn = "external_id") {
  const cache = new Map();
  return async function resolve(rawValue) {
    const key = normalizeKey(rawValue);
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    const name = String(rawValue).trim();
    const { rows } = await client.query(
      `INSERT INTO ${table} (id, org_id, ${keyColumn}, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_id, ${keyColumn}) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [randomUUID(), orgId, key, name]
    );
    const id = rows[0].id;
    cache.set(key, id);
    return id;
  };
}

/**
 * Imports mapped raw rows into the unified model for one data source.
 * Deletes any prior transactions for that data_source_id first (re-import /
 * refresh is "replace", not "append" — keeps refresh idempotent).
 *
 * rows: array of raw row objects (header -> value)
 * mapping: { date, customer, product, region, channel, quantity, unit_price, revenue, discount, cost, currency }
 *          values are the raw header names to read from each row (or null).
 *          `currency` is optional — most exports don't have a per-row
 *          currency column, so its absence isn't an error; see the
 *          per-row fallback below.
 */
export async function importRows({ orgId, dataSourceId, rows, mapping, onProgress }) {
  return withTransaction(async (client) => {
    await client.query(`DELETE FROM transactions WHERE data_source_id = $1`, [dataSourceId]);

    // A row's own currency column (if mapped) always wins; otherwise fall
    // back to this org's configured default rather than a hardcoded "EUR"
    // baked into every row regardless of what the org actually uses. This
    // is still just a label, not a conversion — see the "mixed_currencies"
    // check in dataQuality.js for the case that actually matters (a single
    // dataset mixing currencies, which no default here can fix).
    const { rows: orgRows } = await client.query(
      `SELECT default_currency FROM organizations WHERE id = $1`,
      [orgId]
    );
    const orgDefaultCurrency = orgRows[0]?.default_currency || "EUR";

    const resolveCustomer = await dimensionResolver(client, orgId, "customers");
    const resolveProduct = await dimensionResolver(client, orgId, "products");
    const resolveRegion = await dimensionResolver(client, orgId, "regions", "name");
    const resolveChannel = await dimensionResolver(client, orgId, "channels", "name");

    let imported = 0;
    let skipped = 0;
    const values = [];

    const flush = async () => {
      if (!values.length) return;
      // NOTE: `gross_profit` and `currency` were previously missing from
      // this column list even though `gross_profit` was computed below —
      // it silently never reached the database. `gross_profit` is
      // NOT NULL with no default in schema.sql, so every real import
      // against a real Postgres would fail on this INSERT; vitest never
      // caught it because it mocks pg entirely (see test/setupEnv.js).
      // Fixed here alongside the currency work; verified against a real
      // local Postgres instance, not just the mocked test suite.
      const cols = 16;
      const placeholders = values
        .map((_, i) => `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(",")})`)
        .join(",");
      const flat = values.flat();
      await client.query(
        `INSERT INTO transactions
           (id, org_id, data_source_id, date, customer_id, product_id, region_id, channel_id,
            quantity, unit_price, gross_revenue, discount, net_revenue, cost, gross_profit, currency)
         VALUES ${placeholders}`,
        flat
      );
      values.length = 0;
    };

    for (const row of rows) {
      const date = mapping.date ? parseDate(row[mapping.date]) : null;
      const revenueRaw = mapping.revenue ? parseNumber(row[mapping.revenue]) : null;
      const quantity = mapping.quantity ? parseNumber(row[mapping.quantity]) ?? 1 : 1;
      const unitPrice = mapping.unit_price ? parseNumber(row[mapping.unit_price]) : null;
      const grossRevenue = revenueRaw ?? (unitPrice != null ? unitPrice * quantity : null);

      // A row without a valid date or a derivable revenue can't become a
      // real transaction — it's counted as an issue by dataQuality.js and
      // dropped here rather than silently coerced into fabricated numbers.
      if (!date || grossRevenue == null) {
        skipped++;
        continue;
      }

      const discount = mapping.discount ? parseNumber(row[mapping.discount]) ?? 0 : 0;
      const cost = mapping.cost ? parseNumber(row[mapping.cost]) ?? 0 : 0;
      const netRevenue = grossRevenue - discount;
      const grossProfit = netRevenue - cost;
      const rawCurrency = mapping.currency ? String(row[mapping.currency] ?? "").trim().toUpperCase() : "";
      const currency = rawCurrency || orgDefaultCurrency;

      const customerId = mapping.customer ? await resolveCustomer(row[mapping.customer]) : null;
      const productId = mapping.product ? await resolveProduct(row[mapping.product]) : null;
      const regionId = mapping.region ? await resolveRegion(row[mapping.region]) : null;
      const channelId = mapping.channel ? await resolveChannel(row[mapping.channel]) : null;

      values.push([
        randomUUID(), orgId, dataSourceId, date, customerId, productId, regionId, channelId,
        quantity, unitPrice, grossRevenue, discount, netRevenue, cost, grossProfit, currency,
      ]);
      imported++;
      if (values.length >= CHUNK_SIZE) {
        await flush();
        // FASE 8 progress indicator: report after each flushed chunk, not
        // every row — the worker turns this into the job's `progress`
        // column so the frontend can poll a real "row 42,000 of 180,000"
        // instead of an indeterminate spinner.
        if (onProgress) onProgress(imported, rows.length);
      }
    }
    await flush();
    if (onProgress) onProgress(imported, rows.length);

    await client.query(
      `UPDATE data_sources SET row_count = $2, last_sync_at = now(), status = 'connected' WHERE id = $1`,
      [dataSourceId, imported]
    );

    return { imported, skipped, total: rows.length };
  });
}

export async function getOverview(orgId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(net_revenue), 0)  AS revenue,
       COALESCE(SUM(gross_profit), 0) AS profit,
       COUNT(*)                        AS transactions,
       MIN(date)                       AS from_date,
       MAX(date)                       AS to_date
     FROM transactions WHERE org_id = $1`,
    [orgId]
  );
  const r = rows[0];
  const revenue = Number(r.revenue);
  const profit = Number(r.profit);
  return {
    revenue,
    profit,
    marginPct: revenue ? Number(((profit / revenue) * 100).toFixed(1)) : 0,
    transactions: Number(r.transactions),
    period: { from: r.from_date, to: r.to_date },
  };
}

export async function getMonthlyRevenue(orgId) {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS month,
            COALESCE(SUM(net_revenue), 0) AS revenue,
            COALESCE(SUM(gross_profit), 0) AS profit
     FROM transactions WHERE org_id = $1
     GROUP BY 1 ORDER BY 1`,
    [orgId]
  );
  return rows.map((r) => ({ month: r.month, revenue: Number(r.revenue), profit: Number(r.profit) }));
}
