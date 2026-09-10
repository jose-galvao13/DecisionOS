/* ---------------------------------------------------------------
   ANALYTICS TOOLS — server-side port of the deterministic tool
   layer that used to live in the browser (DecisionOS.jsx).

   Nothing here calls Claude. These functions only read from the
   `analytics` object server.js already computed server-side (FASE 2:
   from this org's own Postgres data, via computeAnalyticsForOrg) and
   return plain numbers. Claude decides *which* of these to call; it
   never computes a number itself — every figure it quotes back to
   the user traces to one of these functions.

   FASE 5 ("AI Advisor 2.0 depende do Decision Engine"): the tools
   below the original set now also expose the Decision Engine
   (decisionEngine.js) and Simulation Engine (simulationEngine.js)
   directly to Claude, so "why did profit drop?" or "what should we
   do about it?" can be answered from the same decisions a person
   sees on the Decision Feed, not a fresh, possibly-inconsistent
   read of the raw numbers.
----------------------------------------------------------------*/
import { generateDecisions } from "./services/decisionEngine.js";
import { findAnomalies } from "./services/anomalyDetection.js";
import { simulateCostChange, simulateVolumeChange, simulateDiscontinueProduct } from "./services/simulationEngine.js";

/* Ordinary-least-squares trend line, ported verbatim from the
   frontend's forecasting code so simulate_* tools use the exact
   same uncertainty model the Forecast tab does. */
export function linregForecast(ys) {
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

/* Default price elasticity, used only when the frontend didn't send a
   fitted analytics.priceElasticity (older client, or a dataset with too
   little price variation to regress on — see estimatePriceElasticity in
   the frontend's computeAnalytics). Marketing (0.25) and churn (0.5) stay
   fixed, stated assumptions unconditionally: the unified data model has no
   marketing-spend field to fit against, and churn's revenue impact isn't
   something a short transaction history can reliably estimate either. */
const DEFAULT_PRICE_ELASTICITY = 0.65;

/* Pure lever-simulation function backing simulate_price_change /
   simulate_marketing_change / simulate_churn. Price elasticity is
   data-derived when the loaded dataset has enough real month-to-month
   price movement to fit (analytics.priceElasticity.source === "estimated");
   otherwise it falls back to the stated 0.65 assumption, and the caller
   (Claude, via the tool result) is told which one it's looking at rather
   than the number being presented as company knowledge either way.
   Marketing and churn elasticities remain stated assumptions. What's
   always data-derived is the uncertainty band and risk label, both driven
   by the dataset's own month-to-month volatility. */
export function simulateLevers(analytics, { price = 0, marketing = 0, churn = 0 } = {}) {
  const baseRevenue = analytics.totals.revenue;
  const baseMargin = analytics.totals.margin / 100;
  const priceElasticity = analytics.priceElasticity || { value: DEFAULT_PRICE_ELASTICITY, source: "assumption", monthsUsed: 0 };
  const dRevPrice = baseRevenue * (price / 100) * priceElasticity.value;
  const dRevMarketing = baseRevenue * (marketing / 100) * 0.25;
  const dRevChurn = -baseRevenue * (churn / 100) * 0.5;
  const dRevenue = dRevPrice + dRevMarketing + dRevChurn;
  const dProfit = dRevenue * baseMargin * 1.1;
  const dMarginPP = baseRevenue ? (dProfit / baseRevenue) * 100 : 0;
  const dCustomersPct = -churn * 0.6 - marketing * 0.05;

  const revModel = analytics.monthly.length >= 3 ? linregForecast(analytics.monthly.map((m) => m.revenue)) : null;
  const cv = revModel && revModel.mean ? Math.min(0.6, Math.abs(revModel.rmse / revModel.mean)) : 0.3;
  const band = { low: dProfit * (1 - cv), high: dProfit * (1 + cv) };
  const months = analytics.monthly.length;
  const risk = months >= 9 && cv < 0.15 ? "low" : months >= 5 && cv < 0.3 ? "medium" : "high";

  return {
    dRevenue, dProfit, dMarginPP, dCustomersPct, band, risk, cv,
    evidenceMonths: months, evidenceRows: analytics.count,
    assumptions: {
      priceElasticity: { value: priceElasticity.value, source: priceElasticity.source, monthsUsed: priceElasticity.monthsUsed ?? 0 },
      marketingElasticity: { value: 0.25, source: "assumption" },
      churnElasticity: { value: 0.5, source: "assumption" },
    },
  };
}

/* Same tool schema Claude sees, unchanged from the frontend version
   — only where it's executed has moved. */
export const AI_TOOLS_SCHEMA = [
  { name: "get_company_overview", description: "Top-line revenue, profit, margin and transaction count for the currently loaded/filtered data.", input_schema: { type: "object", properties: {} } },
  { name: "get_revenue", description: "Total revenue, the monthly revenue series, and the annualized run-rate from the most recent month.", input_schema: { type: "object", properties: {} } },
  { name: "get_profit", description: "Total profit and profit margin.", input_schema: { type: "object", properties: {} } },
  { name: "compare_periods", description: "Revenue/profit % change and margin point change between the 1st and 2nd half of the loaded period.", input_schema: { type: "object", properties: {} } },
  { name: "analyze_products", description: "Per-product revenue, margin, growth (1st vs 2nd half) and profit contribution.", input_schema: { type: "object", properties: {} } },
  { name: "analyze_regions", description: "Per-region revenue and growth.", input_schema: { type: "object", properties: {} } },
  { name: "analyze_channels", description: "Per-channel revenue and margin.", input_schema: { type: "object", properties: {} } },
  { name: "analyze_customers", description: "Customer count, revenue concentration among top customers, and segment counts (new, churned, at-risk, growing, declining).", input_schema: { type: "object", properties: {} } },
  { name: "get_customer_risk", description: "The list of at-risk and churned customers.", input_schema: { type: "object", properties: {} } },
  { name: "get_profit_leaks", description: "The biggest profitability leaks by product/region/channel (margin drop between 1st and 2nd half).", input_schema: { type: "object", properties: {} } },
  { name: "analyze_profit_change", description: "Decompose the change in profit between the 1st and 2nd half of the period into volume, price, discount, cost, and mix/other effects.", input_schema: { type: "object", properties: {} } },
  { name: "forecast_revenue", description: "Base/downside/upside revenue forecast for the next months, derived from the historical trend.", input_schema: { type: "object", properties: {} } },
  { name: "forecast_profit", description: "Base/downside/upside profit forecast for the next months.", input_schema: { type: "object", properties: {} } },
  { name: "simulate_price_change", description: "Simulate the revenue/profit impact of a percentage price change. The result's assumptions.priceElasticity.source tells you whether the elasticity used was 'estimated' from this dataset's own historical price/quantity movements or a stated 'assumption' (insufficient price variation to fit) — always say which one it was when reporting the number back, never present an assumption as measured fact.", input_schema: { type: "object", properties: { percentChange: { type: "number", description: "e.g. 5 for +5%" } }, required: ["percentChange"] } },
  { name: "simulate_marketing_change", description: "Simulate the revenue/profit impact of a percentage change in marketing spend. Uses a stated elasticity assumption (0.25) — the loaded data has no marketing-spend field to estimate from — so always describe it as an assumption, not a measured figure.", input_schema: { type: "object", properties: { percentChange: { type: "number" } }, required: ["percentChange"] } },
  { name: "simulate_churn", description: "Simulate the revenue/profit impact of a percentage change in customer churn. Uses a stated elasticity assumption (0.5) — always describe it as an assumption, not a measured figure.", input_schema: { type: "object", properties: { percentChange: { type: "number" } }, required: ["percentChange"] } },
  { name: "simulate_cost_change", description: "Simulate the profit impact of a percentage change in unit cost/COGS (negative = cost decreases). Revenue is held fixed — this is a pure cost lever, not a demand lever.", input_schema: { type: "object", properties: { percentChange: { type: "number", description: "e.g. -3 for a 3% cost decrease" } }, required: ["percentChange"] } },
  { name: "simulate_volume_change", description: "Simulate the revenue/profit impact of a change in sales volume independent of price (e.g. a demand shock). Assumes cost scales with revenue at the current blended margin — a stated simplification, no fixed/variable cost split is modeled.", input_schema: { type: "object", properties: { percentChange: { type: "number" } }, required: ["percentChange"] } },
  { name: "simulate_discontinue_product", description: "What would happen if this product were discontinued? Unlike the other simulate_* tools this is an EXACT calculation (the product's real revenue/profit for the loaded period, subtracted from the totals) rather than a statistical estimate — say so when reporting it. Assumes no reallocation of freed capacity and no cannibalization by remaining products.", input_schema: { type: "object", properties: { product: { type: "string", description: "Exact product name, as returned by analyze_products" } }, required: ["product"] } },
  { name: "find_anomalies", description: "Find months where revenue or profit deviated statistically from the historical trend (>1.8 standard deviations). Returns an empty list (not an error) when there isn't enough monthly history (need 4+ months) or nothing is actually anomalous — an empty result means nothing was flagged, not that anomaly detection failed.", input_schema: { type: "object", properties: { metric: { type: "string", enum: ["revenue", "profit"], description: "Defaults to revenue" } } } },
  { name: "get_decisions", description: "The full Decision Engine output for the currently loaded/filtered data: revenue decline, margin deterioration, customer risk, product profitability, pricing opportunity, cost leakage, sales anomaly, forecast deviation, and working-capital opportunity — each with its own impact estimate, confidence, evidence, and a concrete recommendation. This is the single best tool for 'why did X happen' or 'what should we do' questions — prefer it over recomputing an answer from the lower-level tools above, since every decision here already cites its own evidence and confidence.", input_schema: { type: "object", properties: {} } },
];

/* Executes exactly one tool call against the given analytics
   snapshot. Ported verbatim from the frontend's runTool — same
   inputs, same outputs, so behavior doesn't change for the model,
   only where the code runs. */
export function runTool(name, input, { analytics }) {
  const round = (v) => (typeof v === "number" ? Math.round(v) : v);
  try {
    switch (name) {
      case "get_company_overview":
        return { revenue: round(analytics.totals.revenue), profit: round(analytics.totals.profit), marginPct: Number(analytics.totals.margin.toFixed(1)), transactions: analytics.count, period: { from: analytics.dateRange.min.slice ? analytics.dateRange.min.slice(0, 10) : analytics.dateRange.min, to: analytics.dateRange.max.slice ? analytics.dateRange.max.slice(0, 10) : analytics.dateRange.max } };
      case "get_revenue":
        return { revenue: round(analytics.totals.revenue), monthly: analytics.monthly.map((m) => ({ month: m.key, revenue: round(m.revenue) })), runRateAnnual: round(analytics.runRateAnnual) };
      case "get_profit":
        return { profit: round(analytics.totals.profit), marginPct: Number(analytics.totals.margin.toFixed(1)) };
      case "compare_periods":
        return { revenuePctChange: Number(analytics.deltas.revenue.toFixed(1)), profitPctChange: Number(analytics.deltas.profit.toFixed(1)), marginChangePP: Number(analytics.deltas.marginPP.toFixed(1)) };
      case "analyze_products":
        return { products: analytics.productIntelligence.map((p) => ({ product: p.product, revenue: round(p.revenue), marginPct: Number(p.margin.toFixed(1)), growthPct: p.growthPct == null ? null : Number(p.growthPct.toFixed(1)), contributionToProfitPct: Number(p.contributionPct.toFixed(1)) })) };
      case "analyze_regions":
        return { byRegion: analytics.byRegion.map((r) => ({ region: r.region, revenue: round(r.value) })), growth: analytics.regionGrowth.map((r) => ({ region: r.region, growthPct: Number(r.growthPct.toFixed(1)), marginPct: Number(r.marginPct.toFixed(1)) })) };
      case "analyze_channels":
        return { byChannel: analytics.byChannel.map((c) => ({ channel: c.channel, revenue: round(c.revenue), marginPct: Number(c.margin.toFixed(1)) })) };
      case "analyze_customers":
        return analytics.customerIntelligence ? { totalCustomers: analytics.customerIntelligence.total, concentrationTop10PctOfRevenue: Number(analytics.customerIntelligence.concentrationPct.toFixed(1)), segmentCounts: analytics.customerIntelligence.counts } : { error: "no customer-level data in this dataset" };
      case "get_customer_risk":
        return analytics.customerIntelligence ? { atRisk: analytics.customerIntelligence.segments.atRisk, churned: analytics.customerIntelligence.segments.churned } : { error: "no customer-level data in this dataset" };
      case "get_profit_leaks":
        return { leaks: analytics.leakage.map((l) => ({ name: l.name, dimension: l.dim, marginChangePP: Number(l.deltaPP.toFixed(1)), estimatedImpact: round(l.impact) })) };
      case "analyze_profit_change":
        return analytics.profitBridge ? Object.fromEntries(Object.entries(analytics.profitBridge).map(([k, v]) => [k, round(v)])) : { error: "not enough history to build a profit bridge" };
      case "forecast_revenue":
        return analytics.forecast ? { confidence: analytics.forecast.confidence, months: analytics.forecast.months.map((m) => ({ monthsAhead: m.h, downside: round(m.revenue.downside), base: round(m.revenue.base), upside: round(m.revenue.upside) })) } : { error: "not enough monthly history to forecast (need 3+ months)" };
      case "forecast_profit":
        return analytics.forecast ? { confidence: analytics.forecast.confidence, months: analytics.forecast.months.map((m) => ({ monthsAhead: m.h, downside: round(m.profit.downside), base: round(m.profit.base), upside: round(m.profit.upside) })) } : { error: "not enough monthly history to forecast (need 3+ months)" };
      case "simulate_price_change":
        return simulateLevers(analytics, { price: input?.percentChange || 0 });
      case "simulate_marketing_change":
        return simulateLevers(analytics, { marketing: input?.percentChange || 0 });
      case "simulate_churn":
        return simulateLevers(analytics, { churn: input?.percentChange || 0 });
      case "simulate_cost_change":
        return simulateCostChange(analytics, input?.percentChange || 0);
      case "simulate_volume_change":
        return simulateVolumeChange(analytics, input?.percentChange || 0);
      case "simulate_discontinue_product":
        return simulateDiscontinueProduct(analytics, input?.product);
      case "find_anomalies":
        return { anomalies: findAnomalies(analytics.monthly, input?.metric === "profit" ? "profit" : "revenue") };
      case "get_decisions":
        return { decisions: generateDecisions(analytics) };
      default:
        return { error: `unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: "tool execution failed" };
  }
}
