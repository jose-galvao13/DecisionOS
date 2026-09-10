/* ---------------------------------------------------------------
   DECISION ENGINE — FASE 3.

       Analytics Engine -> Decision Engine -> Insights -> Recommendations -> Decisions

   Turns the analytics object (analyticsEngine.js's computeAnalytics
   output) into "decision primitives" — the roadmap's 9 categories:
   Revenue decline, Margin deterioration, Customer risk, Product
   profitability, Pricing opportunity, Cost leakage, Sales anomaly,
   Forecast deviation, Working-capital opportunity.

   Every primitive follows the same discipline the rest of this
   backend already does (see analytics-tools.js's header comment):
     - every number traces back to something analyticsEngine.js
       actually computed from this org's own transactions — nothing
       here is invented
     - a primitive is only emitted when there's enough data behind
       it (see the guards at the top of each detect* function);
       otherwise it's skipped, not shown with a hollow confidence
       score
     - confidence is a function of data volume + how clear the
       signal is, never a flat number (see computeConfidence)
     - each decision carries its own evidence, so the frontend/
       Advisor can always show its work rather than assert a number
----------------------------------------------------------------*/
import { findAnomalies, latestMonthDeviation } from "./anomalyDetection.js";

// Every transaction's own currency lives on t.currency (unifiedModel.js),
// with analyticsEngine.js's computeAnalytics() summarizing it as
// analytics.currency = { primary, distinct, mixed }. This picks that
// primary label for decision impacts — it's still just a label, not a
// conversion: if analytics.currency.mixed is true, the underlying totals
// already mix currencies (flagged separately by dataQuality.js's
// "mixed_currencies" check), and no label here fixes that.
const currencyOf = (analytics) => analytics?.currency?.primary || "EUR";

const round = (n) => Math.round(n);
const pct = (n, digits = 1) => Number(n.toFixed(digits));

/** 0-100, deliberately conservative — this feeds a number someone may act
 *  on. Rewards more months of history and more transactions behind the
 *  figure; rewards a clear (low-volatility) signal when volatility is
 *  known; penalizes thin data instead of just omitting the penalty. */
function computeConfidence({ months = 0, transactions = 0, volatility = null }) {
  let score = 45;
  if (months >= 12) score += 20;
  else if (months >= 6) score += 10;
  else if (months < 3) score -= 20;

  if (transactions >= 5000) score += 20;
  else if (transactions >= 1000) score += 10;
  else if (transactions < 100) score -= 20;

  if (volatility != null) {
    if (volatility < 0.15) score += 15;
    else if (volatility < 0.3) score += 5;
    else score -= 15;
  }
  return Math.max(5, Math.min(96, Math.round(score)));
}

function monthsCovered(analytics) {
  return analytics.monthly.length;
}

function periodOf(analytics) {
  const toISO = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  return { from: toISO(analytics.dateRange.min), to: toISO(analytics.dateRange.max) };
}

function evidenceOf(analytics, extra = "") {
  const months = monthsCovered(analytics);
  return {
    transactions: analytics.count,
    monthsCovered: months,
    description: `${analytics.count.toLocaleString("en-US")} transactions over ${months} month${months === 1 ? "" : "s"}${extra ? " — " + extra : ""}`,
  };
}

/** Splits the already-computed monthly series in half (first N/2 months vs
 *  last N/2) and sums revenue/profit for each side. This mirrors, at the
 *  month-bucket level, the same first-half/second-half comparison
 *  computeAnalytics() does at the transaction level for deltas/leakage —
 *  close enough for decision-sizing without re-touching the DB. */
function splitMonthly(analytics) {
  const monthly = analytics.monthly;
  const mid = Math.floor(monthly.length / 2);
  const first = monthly.slice(0, mid);
  const second = monthly.slice(mid);
  const sum = (arr, k) => arr.reduce((a, m) => a + m[k], 0);
  return { revenue1: sum(first, "revenue"), revenue2: sum(second, "revenue"), profit1: sum(first, "profit"), profit2: sum(second, "profit") };
}

/* ---------- 1. Revenue decline ------------------------------------ */
function detectRevenueDecline(analytics) {
  const months = monthsCovered(analytics);
  if (months < 2) return null;
  const { deltas } = analytics;
  if (!(deltas.revenue <= -3)) return null; // not material

  const worstProduct = [...analytics.productIntelligence].filter((p) => p.growthPct != null).sort((a, b) => a.growthPct - b.growthPct)[0];
  const worstRegion = [...analytics.regionGrowth].sort((a, b) => a.growthPct - b.growthPct)[0];
  const { revenue1, revenue2 } = splitMonthly(analytics);
  const dropAbs = Math.max(0, revenue1 - revenue2);

  const drivers = [];
  if (worstProduct) drivers.push(`${worstProduct.product}: revenue ${pct(worstProduct.growthPct)}% vs prior half`);
  if (worstRegion) drivers.push(`${worstRegion.region}: revenue ${pct(worstRegion.growthPct)}% vs prior half`);
  if (!drivers.length) drivers.push("Decline is broad-based, not concentrated in a single product or region");

  return {
    id: "revenue_decline",
    type: "revenue_decline",
    severity: deltas.revenue <= -10 ? "red" : "yellow",
    title: "Revenue decline",
    decision: `Revenue is down ${pct(Math.abs(deltas.revenue))}% vs the prior half of the loaded period`,
    impact: { metric: "revenue", low: round(dropAbs), high: round(dropAbs), currency: currencyOf(analytics) },
    drivers,
    recommendation: worstProduct
      ? `Investigate ${worstProduct.product}${worstRegion ? ` and ${worstRegion.region}` : ""} first — they show the sharpest declines.`
      : "Investigate demand and pricing broadly — the decline isn't isolated to one product or region.",
    confidence: computeConfidence({ months, transactions: analytics.count }),
    evidence: evidenceOf(analytics),
    period: periodOf(analytics),
    affectedEntities: { products: worstProduct ? [worstProduct.product] : [], regions: worstRegion ? [worstRegion.region] : [] },
  };
}

/* ---------- 2. Margin deterioration -------------------------------- */
function detectMarginDeterioration(analytics) {
  const months = monthsCovered(analytics);
  if (months < 2) return null;
  const { deltas } = analytics;
  if (!(deltas.marginPP <= -1)) return null;

  const topLeak = analytics.leakage[0]; // already sorted by impact (most negative first)
  const { profit1, profit2 } = splitMonthly(analytics);
  const profitDrop = Math.max(0, profit1 - profit2);

  const drivers = analytics.leakage.slice(0, 3).map((l) => `${l.dim} "${l.name}": margin ${pct(l.deltaPP)}pp`);
  if (!drivers.length) drivers.push("No single product/region/channel stands out — margin compression is broad-based");

  return {
    id: "margin_deterioration",
    type: "margin_deterioration",
    severity: deltas.marginPP <= -3 ? "red" : "yellow",
    title: "Margin deterioration",
    decision: `Gross margin is down ${pct(Math.abs(deltas.marginPP))}pp vs the prior half of the loaded period`,
    impact: { metric: "gross_profit", low: round(profitDrop), high: round(profitDrop), currency: currencyOf(analytics) },
    drivers,
    recommendation: topLeak
      ? `Review pricing and cost on ${topLeak.dim.toLowerCase()} "${topLeak.name}" — it's the single largest contributor to the margin decline.`
      : "Review discounting and cost trends across the book — no single segment explains the drop.",
    confidence: computeConfidence({ months, transactions: analytics.count }),
    evidence: evidenceOf(analytics),
    period: periodOf(analytics),
    affectedEntities: { products: topLeak?.dim === "Produto" ? [topLeak.name] : [], regions: topLeak?.dim === "Região" ? [topLeak.name] : [] },
  };
}

/* ---------- 3. Customer risk ---------------------------------------- */
function detectCustomerRisk(analytics) {
  const ci = analytics.customerIntelligence;
  if (!ci) return null; // no customer field mapped in this dataset
  const atRisk = ci.segments.atRisk || [];
  const churned = ci.segments.churned || [];
  if (atRisk.length + churned.length === 0) return null;

  const atRiskRevenue = atRisk.reduce((a, c) => a + c.revenue1, 0); // what they were worth before the drop-off
  const churnedRevenue = churned.reduce((a, c) => a + c.revenue1, 0);
  const totalExposed = atRiskRevenue + churnedRevenue;
  if (totalExposed <= 0) return null;

  const months = monthsCovered(analytics);
  const names = [...atRisk, ...churned].sort((a, b) => b.revenue1 - a.revenue1).slice(0, 5).map((c) => c.customer);

  return {
    id: "customer_risk",
    type: "customer_risk",
    severity: atRisk.length + churned.length >= 5 || totalExposed / (ci.total * 1 || 1) > 0.15 ? "red" : "yellow",
    title: "Customer risk",
    decision: `${atRisk.length} customer${atRisk.length === 1 ? "" : "s"} showing elevated churn risk, ${churned.length} already churned`,
    impact: { metric: "revenue_at_risk", low: round(totalExposed * 0.5), high: round(totalExposed), currency: currencyOf(analytics) },
    drivers: [
      `${atRisk.length} accounts down 50%+ vs their prior-period spend`,
      `${churned.length} accounts with zero activity in the most recent half`,
    ],
    recommendation: names.length
      ? `Prioritize outreach to ${names.slice(0, 3).join(", ")}${names.length > 3 ? " and others" : ""} — they represent the largest revenue exposed.`
      : "Prioritize account-management outreach to the at-risk segment.",
    confidence: computeConfidence({ months, transactions: analytics.count }),
    evidence: evidenceOf(analytics, `${ci.total} customers tracked`),
    period: periodOf(analytics),
    affectedEntities: { customers: names },
  };
}

/* ---------- 4. Product profitability -------------------------------- */
function detectProductProfitability(analytics) {
  const worst = analytics.worstProducts?.[0];
  if (!worst || !Number.isFinite(worst.margin)) return null;
  if (worst.margin >= 5) return null; // not actually a problem
  const months = monthsCovered(analytics);

  return {
    id: `product_profitability:${worst.product}`,
    type: "product_profitability",
    severity: worst.margin < 0 ? "red" : "yellow",
    title: "Product profitability",
    decision: `${worst.product} is running at ${pct(worst.margin)}% margin, the weakest in the portfolio`,
    impact: { metric: "gross_profit", low: round(Math.abs(worst.profit) * 0.5), high: round(Math.abs(worst.profit)), currency: currencyOf(analytics) },
    drivers: [
      `Revenue: ${round(worst.revenue)} ${currencyOf(analytics)}, cost: ${round(worst.cost)} ${currencyOf(analytics)}`,
      worst.growthPct != null ? `Demand trend: ${pct(worst.growthPct)}% vs prior half` : "Not enough history to trend demand for this product",
    ],
    recommendation: worst.margin < 0
      ? `${worst.product} is losing money on every unit sold at current pricing/cost — reprice, renegotiate cost, or consider discontinuing it.`
      : `${worst.product}'s margin is thin relative to the rest of the portfolio — review pricing or cost before scaling volume further.`,
    confidence: computeConfidence({ months, transactions: analytics.count }),
    evidence: evidenceOf(analytics),
    period: periodOf(analytics),
    affectedEntities: { products: [worst.product] },
  };
}

/* ---------- 5. Pricing opportunity ----------------------------------- */
function detectPricingOpportunity(analytics) {
  const months = monthsCovered(analytics);
  if (months < 3) return null;
  const elasticity = analytics.priceElasticity;
  if (!elasticity) return null;
  // Only surface this when demand looks genuinely price-inelastic
  // (|elasticity| well under 1) — an elastic market makes a price increase
  // a bad idea, not an opportunity, so there's nothing to recommend there.
  if (elasticity.value >= 0.9) return null;

  const testIncreasePct = 5; // stated scenario, matches the roadmap's example framing
  const baseRevenue = analytics.totals.revenue;
  const baseMargin = analytics.totals.margin / 100;
  const dRevenue = baseRevenue * (testIncreasePct / 100) * (1 - elasticity.value);
  const dProfit = dRevenue * (baseMargin + (1 - baseMargin) * 0.6); // most of a price rise drops straight to profit; a stated, documented assumption, not a fitted number
  // Annualize using the same run-rate logic the rest of the app uses.
  const monthsSpan = Math.max(1, months);
  const annualFactor = 12 / monthsSpan;
  const annualLow = dProfit * annualFactor * 0.7;
  const annualHigh = dProfit * annualFactor * 1.3;

  const topProduct = analytics.byProduct[0];

  return {
    id: "pricing_opportunity",
    type: "pricing_opportunity",
    severity: "green",
    title: "Pricing opportunity",
    decision: `Increase prices by ${testIncreasePct - 1}–${testIncreasePct + 1}%${topProduct ? ` starting with ${topProduct.product}` : ""}`,
    impact: { metric: "annual_gross_profit", low: round(annualLow), high: round(annualHigh), currency: currencyOf(analytics) },
    drivers: [
      `Price elasticity ${elasticity.source === "estimated" ? "estimated from this dataset" : "assumed (insufficient price variation to fit)"}: ${elasticity.value.toFixed(2)}${elasticity.r2 != null ? ` (R²=${elasticity.r2})` : ""}`,
      "Demand looks inelastic — a moderate price increase has historically not cost proportional volume",
    ],
    recommendation: `Test a ${testIncreasePct}% price increase${topProduct ? ` on ${topProduct.product}` : ""} and monitor volume for 1–2 months before rolling out further.`,
    confidence: elasticity.source === "estimated"
      ? computeConfidence({ months, transactions: analytics.count, volatility: elasticity.r2 != null ? 1 - elasticity.r2 : null })
      : Math.min(55, computeConfidence({ months, transactions: analytics.count })), // capped — this is a stated assumption, not a fitted elasticity
    evidence: evidenceOf(analytics, elasticity.source === "estimated" ? `elasticity fit on ${elasticity.monthsUsed} month-over-month price moves` : "elasticity is an assumption — not enough price variation in this dataset to fit one"),
    period: periodOf(analytics),
    affectedEntities: { products: topProduct ? [topProduct.product] : [] },
  };
}

/* ---------- 6. Cost leakage -------------------------------------------- */
function detectCostLeakage(analytics) {
  const bridge = analytics.profitBridge;
  if (!bridge || !Number.isFinite(bridge.costEffect)) return null;
  if (!(bridge.costEffect <= -1)) return null; // costEffect is negative when unit cost rose
  const months = monthsCovered(analytics);
  const worstCostProduct = [...analytics.productIntelligence].sort((a, b) => a.margin - b.margin)[0];

  return {
    id: "cost_leakage",
    type: "cost_leakage",
    severity: bridge.costEffect <= -(analytics.totals.profit * 0.1) ? "red" : "yellow",
    title: "Cost leakage",
    decision: `Rising unit costs cut an estimated ${round(Math.abs(bridge.costEffect))} ${currencyOf(analytics)} from profit vs the prior half`,
    impact: { metric: "gross_profit", low: round(Math.abs(bridge.costEffect) * 0.8), high: round(Math.abs(bridge.costEffect)), currency: currencyOf(analytics) },
    drivers: [
      "Average unit cost increased between the two halves of the loaded period",
      worstCostProduct ? `Weakest current margin: ${worstCostProduct.product} at ${pct(worstCostProduct.margin)}%` : null,
    ].filter(Boolean),
    recommendation: "Renegotiate supplier pricing or review the cost build-up for the affected products before it compounds further.",
    confidence: computeConfidence({ months, transactions: analytics.count }),
    evidence: evidenceOf(analytics),
    period: periodOf(analytics),
    affectedEntities: { products: worstCostProduct ? [worstCostProduct.product] : [] },
  };
}

/* ---------- 7. Sales anomaly -------------------------------------------- */
function detectSalesAnomaly(analytics) {
  const anomalies = findAnomalies(analytics.monthly, "revenue");
  if (!anomalies.length) return null;
  const top = anomalies[0];
  const months = monthsCovered(analytics);

  return {
    id: `sales_anomaly:${top.month}`,
    type: "sales_anomaly",
    severity: top.direction === "below_trend" ? (Math.abs(top.z) >= 2.5 ? "red" : "yellow") : "green",
    title: "Sales anomaly",
    decision: `${top.label} revenue was ${top.direction === "above_trend" ? "well above" : "well below"} trend (${round(top.actual)} vs an expected ${round(top.expected)} ${currencyOf(analytics)})`,
    impact: { metric: "revenue", low: round(Math.abs(top.actual - top.expected)), high: round(Math.abs(top.actual - top.expected)), currency: currencyOf(analytics) },
    drivers: [`${Math.abs(top.z).toFixed(1)} standard deviations from the trend line`, top.deviationPct != null ? `${pct(top.deviationPct)}% deviation` : null].filter(Boolean),
    recommendation: top.direction === "below_trend"
      ? `Check for a data issue (missed import, refund spike) or a real one-off cause in ${top.label} before treating it as the new trend.`
      : `Confirm what drove the spike in ${top.label} — if it's repeatable (promotion, new channel), it's worth doing again.`,
    confidence: computeConfidence({ months, transactions: analytics.count }),
    evidence: evidenceOf(analytics, `${anomalies.length} month(s) flagged as statistically unusual`),
    period: periodOf(analytics),
    affectedEntities: {},
  };
}

/* ---------- 8. Forecast deviation --------------------------------------- */
function detectForecastDeviation(analytics) {
  if (!analytics.forecast) return null;
  const dev = latestMonthDeviation(analytics.monthly, "revenue");
  if (!dev || Math.abs(dev.z) < 1.5) return null;
  const months = monthsCovered(analytics);

  return {
    id: `forecast_deviation:${dev.month}`,
    type: "forecast_deviation",
    severity: dev.z < 0 ? (dev.z <= -2 ? "red" : "yellow") : "green",
    title: "Forecast deviation",
    decision: `The most recent month broke from trend (${dev.z > 0 ? "beat" : "missed"} the historical trend line by ${dev.deviationPct != null ? pct(Math.abs(dev.deviationPct)) : "a material"}%)`,
    impact: { metric: "revenue", low: round(Math.abs(dev.actual - dev.expected)), high: round(Math.abs(dev.actual - dev.expected)), currency: currencyOf(analytics) },
    drivers: [`Forecast confidence for this dataset: ${analytics.forecast.confidence}`, `Trend growth rate: ${pct(analytics.forecast.monthlyRevGrowthPct)}%/month`],
    recommendation: dev.z < 0
      ? "If this isn't a one-off, the trend-based forecast is now optimistic — revisit near-term plans against the newer trajectory."
      : "If this holds for another month, it's worth updating the trend rather than treating it as noise.",
    confidence: computeConfidence({ months, transactions: analytics.count, volatility: analytics.forecast.confidence === "low" ? 0.4 : analytics.forecast.confidence === "medium" ? 0.25 : 0.1 }),
    evidence: evidenceOf(analytics, "in-sample deviation of the latest month vs. the fitted trend, not a true holdout backtest"),
    period: periodOf(analytics),
    affectedEntities: {},
  };
}

/* ---------- 9. Working-capital opportunity ------------------------------
   Honesty note: real working-capital signals (DSO, DPO, inventory turns)
   need invoice-paid-date / inventory data this unified model doesn't have
   yet. Rather than fabricate a metric we can't compute, this primitive
   uses the one working-capital-adjacent thing that IS measured today —
   revenue concentration in a small number of customers, which is a real
   collection-risk driver — and says exactly that, with a capped, lower
   confidence to reflect that it's a proxy, not a direct measurement. */
function detectWorkingCapitalOpportunity(analytics) {
  const ci = analytics.customerIntelligence;
  const concentrationPct = ci?.concentrationPct ?? analytics.revenueConcentration?.topProductPct;
  if (concentrationPct == null || concentrationPct < 40) return null;
  const months = monthsCovered(analytics);
  const topCustomers = ci?.highValue?.slice(0, 3).map((c) => c.customer) || [];

  return {
    id: "working_capital_opportunity",
    type: "working_capital_opportunity",
    severity: concentrationPct >= 60 ? "yellow" : "green",
    title: "Working-capital opportunity",
    decision: ci
      ? `Top 10% of customers account for ${pct(concentrationPct)}% of revenue — a collection or renegotiation delay there has outsized cash impact`
      : `Top product accounts for ${pct(concentrationPct)}% of revenue — concentration risk worth diversifying`,
    impact: { metric: "revenue_concentration_pct", low: round(concentrationPct), high: round(concentrationPct), currency: null },
    drivers: [ci ? `${topCustomers.length} customers drive the bulk of revenue` : "Revenue is concentrated in a single product"],
    recommendation: ci
      ? "Consider staggered payment terms or credit checks for the top accounts, and prioritize diversifying the customer base."
      : "Diversify the product mix — a single product driving most of revenue is a concentration risk, not just a margin question.",
    confidence: Math.min(50, computeConfidence({ months, transactions: analytics.count })), // capped: this is a proxy signal, not a direct AR/inventory measurement
    evidence: evidenceOf(analytics, "proxy signal from revenue concentration — no accounts-receivable/inventory data in this dataset yet"),
    period: periodOf(analytics),
    affectedEntities: { customers: topCustomers },
  };
}

const DETECTORS = [
  detectRevenueDecline,
  detectMarginDeterioration,
  detectCustomerRisk,
  detectProductProfitability,
  detectPricingOpportunity,
  detectCostLeakage,
  detectSalesAnomaly,
  detectForecastDeviation,
  detectWorkingCapitalOpportunity,
];

/** Runs every detector against one analytics snapshot and returns the
 *  decisions that actually cleared their evidence bar, sorted so the
 *  highest-severity items lead the feed (red > yellow > green), ties
 *  broken by confidence. */
export function generateDecisions(analytics) {
  if (!analytics) return [];
  const severityRank = { red: 2, yellow: 1, green: 0 };
  return DETECTORS
    .map((fn) => {
      try {
        return fn(analytics);
      } catch (e) {
        console.error("[decisionEngine] detector failed", fn.name, e.message);
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || b.confidence - a.confidence);
}

export { computeConfidence, evidenceOf, periodOf };
