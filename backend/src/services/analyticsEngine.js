/* ---------------------------------------------------------------
   ANALYTICS ENGINE — FASE 2 ("Mover computeAnalytics() para
   backend"). Ported line-for-line from DecisionOS.jsx's
   computeAnalytics() and its helper functions (groupSum,
   marginLeakage, computeProfitBridge, computeCustomerIntelligence,
   linregForecast, computeForecast, estimatePriceElasticity) —
   same math, same output shape (what analytics-tools.js's runTool
   already expects), only the input now comes from Postgres instead
   of a browser-held transaction array.

   This is what finally lets /api/advisor stop trusting a
   client-supplied `analytics` snapshot (roadmap 🔴 #2): the backend
   loads req.user.orgId's own transactions and computes the exact
   same object itself.
----------------------------------------------------------------*/
import { pool } from "../db/pool.js";
import { ANALYTICS_ROW_CAP } from "../config/limits.js";
import { getCached, setCached, invalidateByPrefix } from "./cache.js";
import { buildRateIndex, rateAsOf } from "./fxRates.js";
import { getActiveDataSourceId } from "./activeSource.js";

/* ---- ported verbatim from DecisionOS.jsx --------------------------- */

const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const monthLabel = (key, locale = "pt-PT") => {
  const [y, m] = key.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(locale, { month: "short" });
};

function groupSum(txs, keyFn) {
  const map = new Map();
  txs.forEach((t) => {
    const k = keyFn(t);
    if (!map.has(k)) map.set(k, { revenue: 0, cost: 0, profit: 0, quantity: 0, grossRevenue: 0, n: 0, customers: new Set() });
    const g = map.get(k);
    g.revenue += t.revenue; g.cost += t.cost; g.profit += t.profit; g.quantity += t.quantity; g.n += 1;
    g.grossRevenue += (t.unitPrice || 0) * (t.quantity || 0);
    if (t.customer) g.customers.add(t.customer);
  });
  return map;
}

function marginLeakage(txs, dimKey, label) {
  if (!txs.some((t) => t[dimKey])) return [];
  const dates = txs.map((t) => t.date.getTime());
  const mid = dates.sort((a, b) => a - b)[Math.floor(dates.length / 2)];
  const first = txs.filter((t) => t.date.getTime() <= mid);
  const second = txs.filter((t) => t.date.getTime() > mid);
  const g1 = groupSum(first, (t) => t[dimKey] || "N/D");
  const g2 = groupSum(second, (t) => t[dimKey] || "N/D");
  const out = [];
  for (const [name, gs2] of g2.entries()) {
    const gs1 = g1.get(name);
    if (!gs1 || gs1.revenue < 1) continue;
    const m1 = gs1.profit / gs1.revenue;
    const m2 = gs2.profit / gs2.revenue;
    const deltaPP = (m2 - m1) * 100;
    const impact = gs2.revenue * (m2 - m1);
    if (deltaPP < 0) out.push({ name, dim: label, deltaPP, impact, revenue: gs2.revenue, marginBefore: m1 * 100, marginAfter: m2 * 100 });
  }
  return out.sort((a, b) => a.impact - b.impact);
}

function computeProfitBridge(first, second) {
  const agg = (arr) => {
    const qty = arr.reduce((a, t) => a + (t.quantity || 0), 0) || 1;
    const grossRevenue = arr.reduce((a, t) => a + (t.unitPrice || 0) * (t.quantity || 0), 0);
    const discount = arr.reduce((a, t) => a + (t.discount || 0), 0);
    const cost = arr.reduce((a, t) => a + t.cost, 0);
    const netRevenue = grossRevenue - discount;
    return {
      qty, grossRevenue, discount, cost, netRevenue,
      avgListPrice: grossRevenue / qty, avgDiscPerUnit: discount / qty,
      avgUnitCost: cost / qty, avgNetPrice: netRevenue / qty,
    };
  };
  const a1 = agg(first), a2 = agg(second);
  const profit1 = a1.netRevenue - a1.cost, profit2 = a2.netRevenue - a2.cost;
  const volumeEffect = (a2.qty - a1.qty) * (a1.avgNetPrice - a1.avgUnitCost);
  const priceEffect = a2.qty * (a2.avgListPrice - a1.avgListPrice);
  const discountEffect = -a2.qty * (a2.avgDiscPerUnit - a1.avgDiscPerUnit);
  const costEffect = -a2.qty * (a2.avgUnitCost - a1.avgUnitCost);
  const totalChange = profit2 - profit1;
  const mixEffect = totalChange - (volumeEffect + priceEffect + discountEffect + costEffect);
  return { totalChange, volumeEffect, priceEffect, discountEffect, costEffect, mixEffect, profit1, profit2 };
}

function computeCustomerIntelligence(txs, splitMid) {
  const byCust = new Map();
  txs.forEach((t) => {
    if (!t.customer) return;
    if (!byCust.has(t.customer)) {
      byCust.set(t.customer, { customer: t.customer, revenue: 0, profit: 0, revenue1: 0, revenue2: 0, firstDate: t.date, lastDate: t.date, n: 0 });
    }
    const c = byCust.get(t.customer);
    c.revenue += t.revenue; c.profit += t.profit; c.n += 1;
    if (t.date.getTime() <= splitMid) c.revenue1 += t.revenue; else c.revenue2 += t.revenue;
    if (t.date < c.firstDate) c.firstDate = t.date;
    if (t.date > c.lastDate) c.lastDate = t.date;
  });
  const customers = [...byCust.values()].sort((a, b) => b.revenue - a.revenue);
  const totalRevenue = customers.reduce((a, c) => a + c.revenue, 0) || 1;
  const topN = Math.max(1, Math.round(customers.length * 0.1));
  const concentrationPct = (customers.slice(0, topN).reduce((a, c) => a + c.revenue, 0) / totalRevenue) * 100;

  const segMap = { new: [], churned: [], atRisk: [], growing: [], declining: [], stable: [] };
  customers.forEach((c) => {
    if (c.revenue1 === 0 && c.revenue2 > 0) segMap.new.push(c);
    else if (c.revenue1 > 0 && c.revenue2 === 0) segMap.churned.push(c);
    else if (c.revenue1 > 0 && c.revenue2 > 0) {
      const growth = (c.revenue2 - c.revenue1) / c.revenue1;
      if (growth <= -0.5) segMap.atRisk.push(c);
      else if (growth >= 0.1) segMap.growing.push(c);
      else if (growth <= -0.1) segMap.declining.push(c);
      else segMap.stable.push(c);
    }
  });
  const top = (arr, n = 6) => arr.sort((a, b) => b.revenue - a.revenue).slice(0, n).map((c) => ({ customer: c.customer, revenue: c.revenue, revenue1: c.revenue1, revenue2: c.revenue2 }));
  return {
    total: customers.length,
    concentrationPct,
    highValue: customers.slice(0, topN).map((c) => ({ customer: c.customer, revenue: c.revenue })),
    counts: Object.fromEntries(Object.entries(segMap).map(([k, v]) => [k, v.length])),
    segments: {
      new: top(segMap.new), churned: top(segMap.churned), atRisk: top(segMap.atRisk),
      growing: top(segMap.growing), declining: top(segMap.declining),
    },
  };
}

function linregForecast(ys) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - xMean) * (ys[i] - yMean); den += (xs[i] - xMean) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = yMean - slope * xMean;
  const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
  const rmse = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / n);
  return { slope, intercept, rmse, mean: yMean };
}

function computeForecast(monthly, horizon = 3) {
  if (monthly.length < 3) return null;
  const revModel = linregForecast(monthly.map((m) => m.revenue));
  const profitModel = linregForecast(monthly.map((m) => m.profit));
  const n = monthly.length;
  const months = [];
  for (let h = 1; h <= horizon; h++) {
    const x = n - 1 + h;
    const revBase = revModel.intercept + revModel.slope * x;
    const profitBase = profitModel.intercept + profitModel.slope * x;
    months.push({
      h,
      revenue: { base: revBase, downside: revBase - 1.28 * revModel.rmse, upside: revBase + 1.28 * revModel.rmse },
      profit: { base: profitBase, downside: profitBase - 1.28 * profitModel.rmse, upside: profitBase + 1.28 * profitModel.rmse },
      marginBase: revBase > 0 ? (profitBase / revBase) * 100 : 0,
    });
  }
  const errRatio = revModel.mean ? revModel.rmse / Math.abs(revModel.mean) : 1;
  const confidence = errRatio < 0.15 ? "high" : errRatio < 0.35 ? "medium" : "low";
  return { months, monthlyRevGrowthPct: revModel.mean ? (revModel.slope / revModel.mean) * 100 : 0, confidence };
}

const DEFAULT_PRICE_ELASTICITY = 0.65;
function estimatePriceElasticity(monthly) {
  const pairs = [];
  for (let i = 1; i < monthly.length; i++) {
    const prev = monthly[i - 1], cur = monthly[i];
    if (!prev.avgUnitPrice || !cur.avgUnitPrice || !prev.quantity) continue;
    const dPrice = (cur.avgUnitPrice - prev.avgUnitPrice) / prev.avgUnitPrice;
    if (Math.abs(dPrice) < 0.01) continue;
    const dQty = (cur.quantity - prev.quantity) / prev.quantity;
    pairs.push({ dPrice, dQty });
  }
  if (pairs.length < 4) {
    return { value: DEFAULT_PRICE_ELASTICITY, source: "assumption", monthsUsed: pairs.length };
  }
  const xs = pairs.map((p) => p.dPrice), ys = pairs.map((p) => p.dQty);
  const n = xs.length;
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - xMean) * (ys[i] - yMean); den += (xs[i] - xMean) ** 2; }
  const b = den ? num / den : 0;
  const a = yMean - b * xMean;
  const predicted = xs.map((x) => a + b * x);
  const ssRes = ys.reduce((s, y, i) => s + (y - predicted[i]) ** 2, 0);
  const ssTot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
  const r2 = ssTot ? 1 - ssRes / ssTot : 0;
  const value = Math.min(3, Math.max(0.05, -b));
  if (r2 < 0.15) {
    return { value: DEFAULT_PRICE_ELASTICITY, source: "assumption", monthsUsed: pairs.length, r2: Number(r2.toFixed(2)) };
  }
  return { value: Number(value.toFixed(2)), source: "estimated", monthsUsed: pairs.length, r2: Number(r2.toFixed(2)) };
}

function computeAnalytics(txs, locale = "pt-PT") {
  if (!txs.length) return null;
  const totals = txs.reduce((a, t) => ({ revenue: a.revenue + t.revenue, cost: a.cost + t.cost, profit: a.profit + t.profit }), { revenue: 0, cost: 0, profit: 0 });
  totals.margin = (totals.profit / totals.revenue) * 100;

  // Which currency label these summed totals are actually in. Rows that
  // could be converted to the org's default currency (see
  // loadOrgTransactions -> fxRates.js) already have revenue/cost/profit
  // IN that default currency and `currency` rewritten to match, so they
  // collapse into one bucket below like they should. Rows that
  // genuinely couldn't be converted (no fx_rate on file covering that
  // date) keep their original currency and their original (unconverted)
  // amounts — `unconvertedCount`/`unconvertedCurrencies` surfaces
  // exactly those, so a caller can tell "this dataset is one currency"
  // apart from "this dataset has 3 stray rows still in USD because
  // nobody set a rate for early 2023 yet". A tx missing `.currency`
  // altogether (older fixtures, callers that never set it) is treated
  // as "EUR" rather than left undefined.
  const currencyCounts = new Map();
  for (const t of txs) {
    const c = t.currency || "EUR";
    currencyCounts.set(c, (currencyCounts.get(c) || 0) + 1);
  }
  const distinctCurrencies = [...currencyCounts.keys()];
  const primaryCurrency = distinctCurrencies.sort((a, b) => currencyCounts.get(b) - currencyCounts.get(a))[0];
  const unconverted = txs.filter((t) => t.fxConverted === false);
  const currency = {
    primary: primaryCurrency, distinct: distinctCurrencies, mixed: distinctCurrencies.length > 1,
    unconvertedCount: unconverted.length,
    unconvertedCurrencies: [...new Set(unconverted.map((t) => t.currency))],
  };

  const dates = txs.map((t) => t.date);
  const dateRange = { min: new Date(Math.min(...dates)), max: new Date(Math.max(...dates)) };

  const monthly = [...groupSum(txs, (t) => monthKey(t.date)).entries()]
    .sort(([a], [b]) => (a > b ? 1 : -1))
    .map(([k, v]) => ({
      key: k, m: monthLabel(k, locale), revenue: v.revenue, profit: v.profit, cost: v.cost,
      quantity: v.quantity, avgUnitPrice: v.quantity ? v.grossRevenue / v.quantity : null,
    }));
  const priceElasticity = estimatePriceElasticity(monthly);

  const byRegion = [...groupSum(txs, (t) => t.region).entries()]
    .map(([region, v]) => ({ region, value: v.revenue }))
    .sort((a, b) => b.value - a.value);

  const byProduct = [...groupSum(txs, (t) => t.product).entries()]
    .map(([product, v]) => ({ product, revenue: v.revenue, cost: v.cost, profit: v.profit, margin: (v.profit / v.revenue) * 100 }))
    .sort((a, b) => b.revenue - a.revenue);

  const byChannel = [...groupSum(txs, (t) => t.channel || "N/D").entries()]
    .map(([channel, v]) => ({ channel, revenue: v.revenue, profit: v.profit, margin: v.revenue ? (v.profit / v.revenue) * 100 : 0 }))
    .sort((a, b) => b.revenue - a.revenue);

  const mid = [...dates].sort((a, b) => a - b)[Math.floor(dates.length / 2)].getTime();
  const first = txs.filter((t) => t.date.getTime() <= mid);
  const second = txs.filter((t) => t.date.getTime() > mid);

  const g1p = groupSum(first, (t) => t.product);
  const g2p = groupSum(second, (t) => t.product);
  const totalProfitForContribution = txs.reduce((a, t) => a + t.profit, 0) || 1;
  const productIntelligence = byProduct.map((p) => {
    const v1 = g1p.get(p.product), v2 = g2p.get(p.product);
    const growthPct = v1 && v1.revenue > 0 && v2 ? ((v2.revenue - v1.revenue) / v1.revenue) * 100 : null;
    return { ...p, growthPct, contributionPct: (p.profit / totalProfitForContribution) * 100 };
  });
  const bestProducts = [...productIntelligence].sort((a, b) => b.margin - a.margin).slice(0, 3);
  const worstProducts = [...productIntelligence].sort((a, b) => a.margin - b.margin).slice(0, 3);
  const sum = (arr, k) => arr.reduce((a, t) => a + t[k], 0);
  const periodDelta = (k) => {
    const f = sum(first, k), s = sum(second, k);
    return f === 0 ? 0 : ((s - f) / Math.abs(f)) * 100;
  };
  const custFirst = new Set(first.map((t) => t.customer).filter(Boolean));
  const custSecond = new Set(second.map((t) => t.customer).filter(Boolean));
  const churned = [...custFirst].filter((c) => !custSecond.has(c));
  const churnRate = custFirst.size ? (churned.length / custFirst.size) * 100 : 0;

  const g1r = groupSum(first, (t) => t.region);
  const g2r = groupSum(second, (t) => t.region);
  const regionGrowth = [...g2r.entries()]
    .map(([region, v2]) => {
      const v1 = g1r.get(region);
      if (!v1 || v1.revenue < 1) return null;
      return {
        region,
        growthPct: ((v2.revenue - v1.revenue) / v1.revenue) * 100,
        marginPct: (v2.profit / v2.revenue) * 100,
        revenue: v2.revenue,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.growthPct - a.growthPct);

  const leakage = [
    ...marginLeakage(txs, "product", "Produto"),
    ...marginLeakage(txs, "region", "Região"),
    ...marginLeakage(txs, "channel", "Canal"),
  ].sort((a, b) => a.impact - b.impact).slice(0, 3);

  const deltas = { revenue: periodDelta("revenue"), profit: periodDelta("profit") };
  const marginFirst = sum(first, "profit") / (sum(first, "revenue") || 1) * 100;
  const marginSecond = sum(second, "profit") / (sum(second, "revenue") || 1) * 100;
  deltas.marginPP = marginSecond - marginFirst;

  const profitBridge = computeProfitBridge(first, second);
  const customerIntelligence = computeCustomerIntelligence(txs, mid);
  const forecast = computeForecast(monthly);

  const lastMonth = monthly[monthly.length - 1];
  const runRateAnnual = lastMonth ? lastMonth.revenue * 12 : 0;
  const revenueConcentration = {
    topProductPct: byProduct[0] ? (byProduct[0].revenue / totals.revenue) * 100 : 0,
    topRegionPct: byRegion[0] ? (byRegion[0].value / totals.revenue) * 100 : 0,
  };

  return {
    totals, monthly, byRegion, byProduct, byChannel, dateRange, leakage, churnRate, regionGrowth, deltas,
    count: txs.length, profitBridge, customerIntelligence, forecast, runRateAnnual, revenueConcentration,
    productIntelligence, bestProducts, worstProducts, priceElasticity, currency,
  };
}

/* ---- new: DB-backed loader + period/product/region/channel filters,
   mirroring the frontend's filterTransactions() so "same filters, same
   answer" holds whether the browser or Claude asks. ------------------- */

async function loadOrgTransactions(orgId) {
  // Only the org's *active* data source is analysed. Without this, every
  // uploaded file's rows were summed together (each upload is its own data
  // source), so uploading a second file doubled the numbers.
  const activeId = await getActiveDataSourceId(orgId);
  if (!activeId) return [];
  const [txResult, orgResult, rateResult] = await Promise.all([
    pool.query(
      `SELECT t.date, t.quantity, t.unit_price, t.discount, t.net_revenue, t.cost, t.gross_profit, t.currency,
              c.name AS customer, p.name AS product, r.name AS region, ch.name AS channel
       FROM transactions t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN products  p ON p.id = t.product_id
       LEFT JOIN regions   r ON r.id = t.region_id
       LEFT JOIN channels ch ON ch.id = t.channel_id
       WHERE t.org_id = $1 AND t.data_source_id = $3
       ORDER BY t.date
       LIMIT $2`,
      [orgId, ANALYTICS_ROW_CAP, activeId]
    ),
    pool.query(`SELECT default_currency FROM organizations WHERE id = $1`, [orgId]),
    pool.query(`SELECT currency, rate_to_default, effective_date FROM fx_rates WHERE org_id = $1`, [orgId]),
  ]);
  const defaultCurrency = orgResult.rows[0]?.default_currency || "EUR";
  const rateIndex = buildRateIndex(rateResult.rows);

  return txResult.rows.map((r) => {
    const date = new Date(r.date);
    const currency = r.currency || "EUR";
    const base = {
      date,
      product: r.product || "N/D",
      region: r.region || "N/D",
      channel: r.channel || null,
      customer: r.customer || null,
      quantity: Number(r.quantity),
      unitPrice: r.unit_price != null ? Number(r.unit_price) : null,
      discount: Number(r.discount),
      revenue: Number(r.net_revenue),
      cost: Number(r.cost),
      profit: Number(r.gross_profit),
    };
    // Real conversion, not just a label (see fxRates.js): a transaction
    // already in the org's default currency needs no rate at all.
    if (currency === defaultCurrency) return { ...base, currency, fxConverted: true, fxRate: 1 };

    const rate = rateAsOf(rateIndex, currency, date);
    if (rate == null) {
      // No fx_rate covers this currency at all — left unconverted,
      // *in its own currency*, deliberately not force-summed into the
      // default. computeAnalytics()'s `currency.unconvertedCount`
      // surfaces this instead of silently mixing amounts.
      return { ...base, currency, fxConverted: false, fxRate: null };
    }
    return {
      ...base,
      revenue: base.revenue * rate,
      cost: base.cost * rate,
      profit: base.profit * rate,
      unitPrice: base.unitPrice != null ? base.unitPrice * rate : null,
      discount: base.discount * rate,
      currency: defaultCurrency,
      originalCurrency: currency,
      fxConverted: true,
      fxRate: rate,
    };
  });
}

function filterTransactionsByPeriod(txs, period) {
  if (!period || period === "all" || !txs.length) return txs;
  const maxTime = Math.max(...txs.map((t) => t.date.getTime()));
  const maxDate = new Date(maxTime);
  let start;
  if (period === "30D") {
    start = new Date(maxDate);
    start.setDate(start.getDate() - 30);
  } else if (period === "QTD") {
    const q = Math.floor(maxDate.getMonth() / 3);
    start = new Date(maxDate.getFullYear(), q * 3, 1);
  } else if (period === "YTD") {
    start = new Date(maxDate.getFullYear(), 0, 1);
  } else {
    return txs;
  }
  return txs.filter((t) => t.date.getTime() >= start.getTime() && t.date.getTime() <= maxTime);
}

function applyFilters(txs, filters = {}) {
  let out = filterTransactionsByPeriod(txs, filters.period);
  if (filters.product && filters.product !== "all") out = out.filter((t) => t.product === filters.product);
  if (filters.region && filters.region !== "all") out = out.filter((t) => t.region === filters.region);
  if (filters.channel && filters.channel !== "all") out = out.filter((t) => (t.channel || "N/D") === filters.channel);
  return out;
}

/** The single entry point routes/tool execution should use: loads this
 *  org's transactions from the database and returns the full analytics
 *  object, honoring the same period/product/region/channel filters the
 *  frontend's filter bar sends. Returns null if the org has no data yet
 *  (mirrors computeAnalytics([]) => null in the frontend). */
export async function computeAnalyticsForOrg(orgId, filters = {}, locale = "pt-PT") {
  // FASE 8 cache: every dashboard tab, the AI advisor, decisions and
  // simulations all call this with the same handful of filter
  // combinations in quick succession — computing it from the full
  // transaction set every single time was the single biggest "queries
  // otimizadas" win available here. Cache is invalidated explicitly by
  // worker.js whenever a data source finishes importing (see
  // invalidateOrgAnalyticsCache below), so it can never serve stale data
  // past the next successful sync.
  const cacheKey = `analytics:${orgId}:${locale}:${JSON.stringify(filters || {})}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const all = await loadOrgTransactions(orgId);
  const filtered = applyFilters(all, filters);
  const result = computeAnalytics(filtered, locale);
  setCached(cacheKey, result, 60_000); // 60s TTL — short enough that even a missed invalidation self-heals fast
  return result;
}

export function invalidateOrgAnalyticsCache(orgId) {
  invalidateByPrefix(`analytics:${orgId}:`);
}

/** P2 — measurementEngine.js's only real dependency on this file: sums a
 *  single metric (`revenue` or `gross_profit`, the only two units
 *  decisionEngine.js's `impact.metric` currently produces that map onto a
 *  raw transaction field) over `[from, to)`. Returns null for any metric
 *  it doesn't know how to compute — e.g. `revenue_concentration_pct` or
 *  `revenue_at_risk` are not a sum over a date range, so automatic
 *  measurement must skip those rather than silently returning a wrong
 *  number for them. `txs` is expected to already be loadOrgTransactions()'s
 *  output (date: Date, revenue/profit: number).
 */
export function sumMetricInRange(txs, metric, from, to) {
  const field = metric === "revenue" ? "revenue" : metric === "gross_profit" ? "profit" : null;
  if (!field) return null;
  const fromTime = from.getTime();
  const toTime = to.getTime();
  return txs.reduce((acc, t) => {
    const tt = t.date.getTime();
    return tt >= fromTime && tt < toTime ? acc + t[field] : acc;
  }, 0);
}

export { computeAnalytics, loadOrgTransactions, applyFilters };
