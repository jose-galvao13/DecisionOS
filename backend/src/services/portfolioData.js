/* ---------------------------------------------------------------
   PORTFOLIO DATA — Parte 2, FASE 4 ("Ligação ao resto").

   The DB-touching half of the portfolio analytics, extracted from
   routes/portfolio.routes.js so the three new consumers of the
   portfolio (the concentration alert in notifications.js, the
   sell-position simulation in routes/simulation.routes.js and the AI
   Advisor's portfolio tools in server.js) read exactly the same
   numbers GET /api/portfolio/analytics returns — one loader, one cache
   key, instead of three re-implementations that could drift apart.

   The pure maths stays in portfolioAnalytics.js / riskAnalytics.js;
   nothing here computes a metric.
----------------------------------------------------------------*/
import { pool } from "../db/pool.js";
import { getCached, setCached } from "./cache.js";
import { buildRateIndex } from "./fxRates.js";
import { buildPortfolioAnalytics } from "./portfolioAnalytics.js";

const ANALYTICS_TTL_MS = 60_000;
const SERIES_TTL_MS = 5 * 60 * 1000;

/** Positions summed by ticker across every import this org has (ponto 6:
 *  "todas as posições de todos os ficheiros somam-se por ticker" — there is
 *  no concept of "which file a holding belongs to" once it's in the total),
 *  each joined to its latest known price (DISTINCT ON, newest first).
 *  preco_medio is the quantity-weighted average across every lot. */
export async function loadAggregatedHoldings(orgId) {
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
    [orgId]
  );

  const tickers = rows.map((r) => r.ticker);
  let latestByTicker = {};
  if (tickers.length) {
    const { rows: priceRows } = await pool.query(
      `SELECT DISTINCT ON (ticker) ticker, preco, moeda, data, origem
         FROM security_prices
        WHERE org_id = $1 AND ticker = ANY($2)
        ORDER BY ticker, data DESC, created_at DESC`,
      [orgId, tickers]
    );
    latestByTicker = Object.fromEntries(priceRows.map((p) => [p.ticker, p]));
  }

  return rows.map((r) => {
    const quantidade = Number(r.quantidade);
    const precoMedio = Number(r.preco_medio);
    const latest = latestByTicker[r.ticker];
    const precoAtual = latest ? Number(latest.preco) : null;
    return {
      ticker: r.ticker,
      nome: r.nome,
      sector: r.sector,
      pais: r.pais,
      tipoAtivo: r.tipo_ativo,
      quantidade,
      precoMedio,
      moeda: r.moeda,
      precoAtual,
      fileCount: Number(r.file_count),
      lastPriceDate: latest?.data || null,
      lastPriceSource: latest?.origem || null,
    };
  });
}

/** The exact object GET /api/portfolio/analytics returns, cached per org
 *  for 60s under `portfolio-analytics:{orgId}` (the key
 *  invalidatePortfolioAnalyticsCache() clears). */
export async function loadPortfolioAnalytics(orgId) {
  const cacheKey = `portfolio-analytics:${orgId}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const [positions, orgResult, rateResult] = await Promise.all([
    loadAggregatedHoldings(orgId),
    pool.query(`SELECT default_currency FROM organizations WHERE id = $1`, [orgId]),
    pool.query(`SELECT currency, rate_to_default, effective_date FROM fx_rates WHERE org_id = $1`, [orgId]),
  ]);
  const defaultCurrency = orgResult.rows[0]?.default_currency || "EUR";
  const rateIndex = buildRateIndex(rateResult.rows);

  const analytics = buildPortfolioAnalytics(positions, { defaultCurrency, rateIndex });
  setCached(cacheKey, analytics, ANALYTICS_TTL_MS);
  return analytics;
}

/** Daily closes from price_history for the given tickers, in the
 *  { [ticker]: [{ data: 'YYYY-MM-DD', fecho }] } shape riskAnalytics.js
 *  takes. Cached under `portfolio-risk:{orgId}:…` so that
 *  invalidateRiskAnalyticsCache(orgId) (any price-history write) also
 *  drops it. */
export async function loadPriceSeries(orgId, tickers) {
  const list = [...new Set(tickers)].sort();
  const seriesByTicker = {};
  for (const t of list) seriesByTicker[t] = [];
  if (!list.length) return seriesByTicker;

  const cacheKey = `portfolio-risk:${orgId}:series:${list.join(",")}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const { rows } = await pool.query(
    `SELECT ticker, to_char(data, 'YYYY-MM-DD') AS data, fecho
       FROM price_history
      WHERE org_id = $1 AND ticker = ANY($2)
      ORDER BY ticker, data ASC`,
    [orgId, list]
  );
  for (const r of rows) seriesByTicker[r.ticker].push({ data: r.data, fecho: Number(r.fecho) });
  setCached(cacheKey, seriesByTicker, SERIES_TTL_MS);
  return seriesByTicker;
}

/** Everything a portfolio what-if needs: the analytics plus the price
 *  series of every position that can actually be sized (has a price and
 *  an fx rate — the others are outside every weight, see
 *  portfolioAnalytics.js, so their history would never be used). */
export async function loadPortfolioContext(orgId) {
  const analytics = await loadPortfolioAnalytics(orgId);
  const tickers = analytics.positions.filter((p) => p.pesoPct != null).map((p) => p.ticker);
  const seriesByTicker = await loadPriceSeries(orgId, tickers);
  return { analytics, seriesByTicker };
}
