/* ---------------------------------------------------------------
   RISK ANALYTICS — Parte 2, FASE 3 ("Risco com histórico de preços").

   Deliberately its own module, DB-free and pure (ponto 2: "num módulo
   separado"), same reasoning as services/portfolioAnalytics.js: routes
   and tests can feed it plain { ticker: [{ data, fecho }, ...] } series
   with no mocking required, and the maths never has to know where the
   prices came from (Excel upload, manual entry, or services/marketData.js).

   Every metric that needs a minimum sample size returns null and is
   flagged `insufficientData: true` below RISK_MIN_OBSERVATIONS daily
   returns (ponto 2: "abaixo disso, 'dados insuficientes'") rather than
   computing a statistically meaningless number from a handful of points.
----------------------------------------------------------------*/
import { RISK_MIN_OBSERVATIONS } from "../config/limits.js";
import { invalidateByPrefix } from "./cache.js";

export const MIN_OBSERVATIONS = RISK_MIN_OBSERVATIONS;

/** GET /api/portfolio/risk (routes/priceHistory.routes.js) caches its
 *  result for a few minutes (see cache.js). Called after anything that
 *  changes price_history for an org — a completed upload (worker.js) or
 *  a manual/API price write — same "invalidate explicitly, don't wait
 *  out the TTL" convention as invalidatePortfolioAnalyticsCache. */
export function invalidateRiskAnalyticsCache(orgId) {
  invalidateByPrefix(`portfolio-risk:${orgId}`);
}

/** Ascending-by-date sort — every function below assumes oldest-first. */
function sortAsc(prices) {
  return [...prices].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
}

/** Daily simple returns: (P_t - P_t-1) / P_t-1. Returns a list of
 *  { data, ret } — `data` is the *later* of each pair's two dates, i.e.
 *  the day the return is "on", which is what the caller aligns tickers
 *  against for correlation/beta. A non-positive previous price (shouldn't
 *  happen — `fecho` is CHECK > 0 in the schema — but a defensively-read
 *  series might still have one) is skipped rather than dividing by it. */
export function computeDailyReturns(prices) {
  const sorted = sortAsc(prices);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].fecho;
    const curr = sorted[i].fecho;
    if (prev > 0) out.push({ data: sorted[i].data, ret: (curr - prev) / prev });
  }
  return out;
}

/** Sample standard deviation (n-1 denominator) — the usual convention for
 *  a return series that is itself a sample, not the whole population. */
export function stddev(values) {
  if (!values.length) return null;
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function mean(values) {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
}

/** Ponto 2: "volatilidade anualizada = desvio-padrão × √252" — 252 being
 *  the standard convention for trading days/year. */
export function annualizedVolatility(returns) {
  const sd = stddev(returns);
  return sd == null ? null : sd * Math.sqrt(252);
}

/** Peak-to-trough curve, one point per price, as a *fraction* (0 at a new
 *  high, negative below the running peak — e.g. -0.35 is a 35% drawdown).
 *  Never null: even a single price has a defined (zero) drawdown. Kept
 *  separate from maxDrawdown() below so the UI's drawdown chart and the
 *  KPI's single "worst" number are computed from the same walk instead of
 *  two slightly different implementations drifting apart. */
export function drawdownCurve(prices) {
  const sorted = sortAsc(prices);
  let peak = -Infinity;
  return sorted.map((p) => {
    if (p.fecho > peak) peak = p.fecho;
    const drawdown = peak > 0 ? (p.fecho - peak) / peak : 0;
    return { data: p.data, drawdown };
  });
}

/** Ponto 2: "Drawdown máximo" — the single worst point on the curve
 *  above. Returns 0 (not null) for an empty series' vacuous case is
 *  avoided by the caller checking prices.length first. */
export function maxDrawdown(prices) {
  const curve = drawdownCurve(prices);
  return curve.length ? Math.min(...curve.map((c) => c.drawdown)) : null;
}

/** Ponto 2: "VaR histórico a 95%" — the loss at the 5th percentile of the
 *  historical return distribution, expressed as a *positive* fraction
 *  (0.032 = "on the worst 5% of days, lost 3.2% or more"), which is the
 *  usual sign convention for VaR even though the underlying return is
 *  negative. Uses the empirical percentile (nearest-rank on the sorted
 *  sample) rather than assuming a normal distribution — "histórico", not
 *  parametric VaR. */
export function historicalVaR95(returns) {
  if (!returns.length) return null;
  const sorted = [...returns].sort((a, b) => a - b);
  const idx = Math.min(Math.floor(0.05 * sorted.length), sorted.length - 1);
  return -sorted[idx];
}

function covariance(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (x[i] - mx) * (y[i] - my);
  return sum / (n - 1);
}

/** Pearson correlation coefficient between two equal-length, already
 *  date-aligned return arrays. Returns null (not 0 or NaN) when either
 *  series is constant (zero variance — correlation is undefined, not
 *  zero) or there are fewer than 2 paired observations. */
export function correlation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const sdX = stddev(x.slice(0, n));
  const sdY = stddev(y.slice(0, n));
  if (!sdX || !sdY) return null;
  const cov = covariance(x, y);
  return cov == null ? null : cov / (sdX * sdY);
}

/** Ponto 2: "Beta face a um índice carregado como série" — cov(asset,
 *  index) / var(index), the standard single-factor beta. Returns null
 *  when the index has (near-)zero variance (undefined beta) or there
 *  are fewer than 2 paired observations. */
export function beta(assetReturns, indexReturns) {
  const n = Math.min(assetReturns.length, indexReturns.length);
  if (n < 2) return null;
  const idx = indexReturns.slice(0, n);
  const varIdx = stddev(idx);
  if (!varIdx) return null;
  const cov = covariance(assetReturns.slice(0, n), idx);
  return cov == null ? null : cov / (varIdx * varIdx);
}

/** Returns the two return series restricted to the dates they share, in
 *  matching order — what correlation()/beta() need as input, since two
 *  tickers' price_history rarely cover exactly the same calendar days
 *  (holidays differ by exchange, one file starts later than another...). */
function alignByDate(mapA, mapB) {
  const commonDates = [...mapA.keys()].filter((d) => mapB.has(d)).sort();
  return {
    dates: commonDates,
    a: commonDates.map((d) => mapA.get(d)),
    b: commonDates.map((d) => mapB.get(d)),
  };
}

/**
 * FASE 4 — historical VaR 95% of a WEIGHTED portfolio (what the Decision
 * Simulator's "vender posição" tab compares before/after).
 *
 * Same method as historicalVaR95() above, applied to the portfolio's own
 * daily return series: on each date the portfolio return is
 * Σ weight_i × return_i (weights held constant — a constant-mix
 * approximation, no intra-window rebalancing model), then the 5th
 * percentile of that series. Empirical, not parametric.
 *
 * Honest about what it can't cover:
 *   - a ticker with fewer than `minObservations` daily returns is left
 *     OUT (never padded/guessed) and the remaining weights are
 *     renormalised over the covered ones; `coveredWeightPct` tells the
 *     caller how much of the portfolio the number actually describes;
 *   - only dates on which EVERY covered ticker has a return are used
 *     (a shorter window beats mixing tickers over different days);
 *   - returns are in each ticker's own price currency — currency moves
 *     against the portfolio's base currency are not modelled.
 *
 * @param weights  { [ticker]: weight }, any positive scale (renormalised)
 * @param window   optional `result.window` of a previous call. Forces the
 *   SAME tickers and dates, so a before/after pair differs only by the
 *   weights and never by a moving sample window.
 * @returns { var95Pct, insufficientData, observations, coveredWeightPct,
 *            coveredTickers, excludedTickers, from, to, window }
 *   var95Pct is null (and insufficientData true) when nothing is covered
 *   or the common window is under minObservations.
 */
export function computePortfolioVaR95(weights, seriesByTicker, { minObservations = MIN_OBSERVATIONS, window = null } = {}) {
  const held = Object.keys(weights).filter((t) => weights[t] > 0);
  const totalWeight = held.reduce((s, t) => s + weights[t], 0);

  const returnMaps = {};
  const covered = [];
  const excluded = [];
  for (const t of held) {
    if (window && !window.tickers.includes(t)) { excluded.push(t); continue; }
    const rets = computeDailyReturns(seriesByTicker[t] || []);
    if (!window && rets.length < minObservations) { excluded.push(t); continue; }
    returnMaps[t] = new Map(rets.map((r) => [r.data, r.ret]));
    covered.push(t);
  }

  const coveredWeight = covered.reduce((s, t) => s + weights[t], 0);
  const coveredWeightPct = totalWeight > 0 ? (coveredWeight / totalWeight) * 100 : 0;
  const empty = (observations = 0) => ({
    var95Pct: null, insufficientData: true, observations, coveredWeightPct,
    coveredTickers: covered, excludedTickers: excluded, from: null, to: null, window: null,
  });
  if (!covered.length || coveredWeight <= 0) return empty();

  let dates = window
    ? window.dates
    : [...returnMaps[covered[0]].keys()].filter((d) => covered.every((t) => returnMaps[t].has(d))).sort();
  if (window) dates = dates.filter((d) => covered.every((t) => returnMaps[t].has(d)));
  if (dates.length < minObservations) return empty(dates.length);

  const portfolioReturns = dates.map((d) => covered.reduce((s, t) => s + (weights[t] / coveredWeight) * returnMaps[t].get(d), 0));
  return {
    var95Pct: historicalVaR95(portfolioReturns) * 100,
    insufficientData: false,
    observations: dates.length,
    coveredWeightPct,
    coveredTickers: covered,
    excludedTickers: excluded,
    from: dates[0],
    to: dates[dates.length - 1],
    window: { tickers: covered, dates },
  };
}

/**
 * Full pipeline for the "Risco" tab: raw price series per ticker ->
 * per-ticker volatility/drawdown/VaR/beta + a correlation matrix across
 * every ticker pair.
 *
 * @param seriesByTicker  { [ticker]: [{ data: 'YYYY-MM-DD', fecho }, ...] }
 * @param indexTicker     one of seriesByTicker's own keys, used as the
 *   market factor for beta — a plain series, no special treatment beyond
 *   "loaded as a series" (ponto 2), so any ticker can serve as the index.
 * @param minObservations override for tests; defaults to RISK_MIN_OBSERVATIONS.
 */
export function buildRiskAnalytics(seriesByTicker, { indexTicker = null, minObservations = MIN_OBSERVATIONS } = {}) {
  const tickers = Object.keys(seriesByTicker);
  const returnsByTicker = {}; // ticker -> Map(date -> ret)
  const perTicker = {};

  for (const ticker of tickers) {
    const prices = sortAsc(seriesByTicker[ticker] || []);
    const returns = computeDailyReturns(prices);
    returnsByTicker[ticker] = new Map(returns.map((r) => [r.data, r.ret]));

    const observations = returns.length;
    const insufficientData = observations < minObservations;
    const retValues = returns.map((r) => r.ret);

    perTicker[ticker] = {
      ticker,
      priceObservations: prices.length,
      observations,
      insufficientData,
      volatilidadeAnualizada: insufficientData ? null : annualizedVolatility(retValues),
      maxDrawdownPct: prices.length ? maxDrawdown(prices) * 100 : null,
      var95Pct: insufficientData ? null : historicalVaR95(retValues) * 100,
      drawdownCurve: drawdownCurve(prices).map((c) => ({ data: c.data, drawdownPct: c.drawdown * 100 })),
      beta: null,
      betaObservations: 0,
      betaInsufficientData: null, // null = n/a (no index configured), not "sufficient"
    };
  }

  if (indexTicker && returnsByTicker[indexTicker]) {
    const idxMap = returnsByTicker[indexTicker];
    for (const ticker of tickers) {
      if (ticker === indexTicker) continue;
      const { a, b, dates } = alignByDate(returnsByTicker[ticker], idxMap);
      const sufficient = dates.length >= minObservations;
      perTicker[ticker].betaObservations = dates.length;
      perTicker[ticker].betaInsufficientData = !sufficient;
      perTicker[ticker].beta = sufficient ? beta(a, b) : null;
    }
  }

  const correlationMatrix = {};
  for (const a of tickers) {
    correlationMatrix[a] = {};
    for (const b of tickers) {
      if (a === b) {
        correlationMatrix[a][b] = returnsByTicker[a].size ? 1 : null;
        continue;
      }
      const aligned = alignByDate(returnsByTicker[a], returnsByTicker[b]);
      correlationMatrix[a][b] = correlation(aligned.a, aligned.b);
    }
  }

  return {
    minObservations,
    indexTicker,
    tickers,
    perTicker,
    correlationMatrix,
  };
}
