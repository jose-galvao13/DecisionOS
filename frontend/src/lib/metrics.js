// Pure analytics functions: monthly aggregation, margin leakage,
// alerts, customer intelligence, forecasting, elasticity. No React,
// no side effects — safe to unit test in isolation (see FASE 9).

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
    // grossRevenue (unit price × qty, pre-discount) is what price-elasticity
    // estimation regresses on below — net revenue would confound price moves
    // with the separate discount effect already tracked by the profit bridge.
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

/* Evidence quality is computed here, deterministically, from the shape of the
   connected dataset — not self-reported by the LLM. A model saying "87%
   confidence" gives a false sense of statistical rigor it doesn't have; this
   instead reflects concrete, checkable signals: how many months of history
   exist, how many transactions back that history, and whether any leakage
   pattern was found at all. */
/* Alert Engine — deterministic, computed straight from the analytics that
   already exist (leakage, churn, region growth). No LLM call: these are
   threshold checks over real numbers, which is what makes them trustworthy
   enough to lead the Overview. */
function computeAlerts(analytics) {
  const alerts = [];
  const worstLeak = analytics.leakage[0];
  if (worstLeak && worstLeak.deltaPP <= -3) {
    alerts.push({ tone: "red", type: "margin", name: worstLeak.name, pp: worstLeak.deltaPP });
  }
  if (analytics.churnRate >= 15) {
    alerts.push({ tone: "yellow", type: "churn", rate: analytics.churnRate });
  }
  const opportunity = analytics.regionGrowth.find((r) => r.growthPct >= 10 && r.marginPct >= analytics.totals.margin);
  if (opportunity) {
    alerts.push({ tone: "green", type: "growth", region: opportunity.region, growth: opportunity.growthPct, margin: opportunity.marginPct });
  }
  const bridge = analytics.profitBridge;
  if (bridge && bridge.costEffect <= -0.03 * Math.abs(bridge.profit1 || 1)) {
    alerts.push({ tone: "red", type: "cost", impact: bridge.costEffect });
  }
  if (bridge && bridge.discountEffect <= -0.03 * Math.abs(bridge.profit1 || 1)) {
    alerts.push({ tone: "yellow", type: "discount", impact: bridge.discountEffect });
  }
  const decliningProduct = (analytics.worstProducts || []).find((p) => p.growthPct != null && p.growthPct <= -15);
  if (decliningProduct) {
    alerts.push({ tone: "yellow", type: "productDecline", product: decliningProduct.product, growth: decliningProduct.growthPct });
  }
  if (analytics.customerIntelligence && analytics.customerIntelligence.counts.atRisk >= 3) {
    alerts.push({ tone: "yellow", type: "customerRisk", n: analytics.customerIntelligence.counts.atRisk });
  }
  return alerts.slice(0, 4);
}

function computeEvidenceQuality(analytics) {
  const months = analytics.monthly.length;
  const rows = analytics.count;
  const hasPattern = analytics.leakage.length > 0;
  let level = "low";
  if (months >= 6 && rows >= 200) level = "high";
  else if (months >= 3 && rows >= 50) level = "medium";
  return {
    level,
    months, rows, hasPattern,
  };
}

/* Period filter operates on the unified transaction list and is anchored to
   the most recent date present in the loaded data (not the real-world "today"),
   since the connected dataset may be historical or a fixed demo export. */
function filterTransactionsByPeriod(txs, period) {
  if (period === "all" || !txs.length) return txs;
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

// Global filters: Period + Product + Region + Channel, applied together and
// shared by every analytical view (Overview, BI, Profit, Customers, Invest,
// Simulator, Advisor) plus the AI digest, so "why is Product X underperforming
// in Germany" reflects exactly that slice.
function filterTransactions(txs, filters = {}) {
  let out = filterTransactionsByPeriod(txs, filters.period || "all");
  if (filters.product && filters.product !== "all") out = out.filter((t) => t.product === filters.product);
  if (filters.region && filters.region !== "all") out = out.filter((t) => t.region === filters.region);
  if (filters.channel && filters.channel !== "all") out = out.filter((t) => (t.channel || "N/D") === filters.channel);
  return out;
}

/* ---------------------------------------------------------------
   PROFIT BRIDGE — "why did profit change?" decomposed into
   volume / price / discount / cost effects, with a residual "mix &
   other" term. This is portfolio-level (not per-SKU), so mix here
   also absorbs product-mix shift and second-order interaction —
   that's stated explicitly wherever it's shown, rather than
   presented as more precise than it is.
----------------------------------------------------------------*/
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

/* ---------------------------------------------------------------
   CUSTOMER INTELLIGENCE — segments derived from real per-customer
   revenue in the 1st vs 2nd half of the loaded period, plus revenue
   concentration among the top decile of customers.
----------------------------------------------------------------*/
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

/* ---------------------------------------------------------------
   FORECASTING — ordinary-least-squares trend line per monthly
   series, with a base/conservative/upside band derived from the
   model's own residual error (not an arbitrary multiplier). Needs
   at least 3 months of history to fit a trend at all.
----------------------------------------------------------------*/
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

/* ---------------------------------------------------------------
   PRICE ELASTICITY — estimated from the dataset's own month-to-month
   average-price and quantity movements when there's enough real
   variation to regress on. Falls back to a clearly-labeled
   assumption (the same 0.65 the simulator always used) when the
   data can't support a fit. This is what the Decision Simulator
   actually needed: never present a stated assumption as if it were
   learned from the company's own data.

   Marketing and churn elasticities stay assumptions unconditionally
   — the unified data model (date/product/customer/region/channel/
   quantity/unitPrice/discount/cost) has no marketing-spend field to
   regress against, and churn's revenue impact isn't the kind of
   thing a short transaction history can reliably fit either.
----------------------------------------------------------------*/
const DEFAULT_PRICE_ELASTICITY = 0.65;
function estimatePriceElasticity(monthly) {
  const pairs = [];
  for (let i = 1; i < monthly.length; i++) {
    const prev = monthly[i - 1], cur = monthly[i];
    if (!prev.avgUnitPrice || !cur.avgUnitPrice || !prev.quantity) continue;
    const dPrice = (cur.avgUnitPrice - prev.avgUnitPrice) / prev.avgUnitPrice;
    // Near-zero price moves make %ΔQty/%ΔPrice blow up and would dominate
    // the fit with noise rather than signal, so they're excluded.
    if (Math.abs(dPrice) < 0.01) continue;
    const dQty = (cur.quantity - prev.quantity) / prev.quantity;
    pairs.push({ dPrice, dQty });
  }
  if (pairs.length < 4) {
    return { value: DEFAULT_PRICE_ELASTICITY, source: "assumption", monthsUsed: pairs.length };
  }
  // OLS: %ΔQty = a + b·%ΔPrice. Elasticity (demand-curve slope) is -b.
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
  // A fitted slope from a handful of noisy monthly points can occasionally
  // land somewhere implausible — clamp to a defensible economic range
  // rather than let one outlier month swing the simulator wildly.
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

  // Product Intelligence: growth (1st vs 2nd half) and contribution to total profit,
  // layered on top of the existing byProduct revenue/margin breakdown.
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

  // Revenue Intelligence: run-rate from the most recent month, and revenue
  // concentration (share of total revenue held by the single biggest product/region).
  const lastMonth = monthly[monthly.length - 1];
  const runRateAnnual = lastMonth ? lastMonth.revenue * 12 : 0;
  const revenueConcentration = {
    topProductPct: byProduct[0] ? (byProduct[0].revenue / totals.revenue) * 100 : 0,
    topRegionPct: byRegion[0] ? (byRegion[0].value / totals.revenue) * 100 : 0,
  };

  return {
    totals, monthly, byRegion, byProduct, byChannel, dateRange, leakage, churnRate, regionGrowth, deltas,
    count: txs.length, profitBridge, customerIntelligence, forecast, runRateAnnual, revenueConcentration,
    productIntelligence, bestProducts, worstProducts, priceElasticity,
  };
}


export {
  monthKey, monthLabel, groupSum, marginLeakage, computeAlerts,
  computeEvidenceQuality, filterTransactionsByPeriod, filterTransactions,
  computeProfitBridge, computeCustomerIntelligence, linregForecast,
  computeForecast, estimatePriceElasticity, computeAnalytics,
};
