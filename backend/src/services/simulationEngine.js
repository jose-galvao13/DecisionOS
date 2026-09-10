/* ---------------------------------------------------------------
   SIMULATION ENGINE — FASE 4 ("What if?").

   Every simulate* function takes the org's already-computed
   `analytics` object (analyticsEngine.js) plus scenario parameters
   and returns { current, scenario, impact, assumptions, confidence,
   evidence } — the roadmap's "Current -> Scenario -> Estimated
   impact" shape.

   Two kinds of levers here, and they're labeled differently on
   purpose:
     - price / cost / volume / churn are STATISTICAL what-ifs: they
       apply a stated or fitted elasticity to the totals. The
       `assumptions` block always says which elasticities were
       fitted from this dataset ("estimated") vs stated
       ("assumption") — never presented as measured fact either way.
     - discontinue_product is an EXACT what-if: productIntelligence
       already has that product's real revenue/profit, so "remove
       it" is a subtraction, not a statistical estimate. It still
       carries a stated assumption (no reallocation/cannibalization
       of the freed capacity/demand).
----------------------------------------------------------------*/
import { linregForecast } from "../analytics-tools.js";

const DEFAULT_PRICE_ELASTICITY = 0.65;
// Stated assumptions — the unified data model has no marketing-spend or
// fixed/variable cost split to fit these against. Kept identical to the
// values analytics-tools.js already uses so a scenario run from the
// Simulation Engine and one run by the AI Advisor never disagree.
const MARKETING_ELASTICITY = 0.25;
const CHURN_ELASTICITY = 0.5;
const OPERATING_LEVERAGE = 1.1; // profit moves slightly faster than revenue on a revenue-driven change — fixed costs don't scale with volume

function round(n) {
  return Math.round(n);
}

function currentSnapshot(analytics) {
  return {
    revenue: round(analytics.totals.revenue),
    profit: round(analytics.totals.profit),
    marginPct: Number(analytics.totals.margin.toFixed(1)),
  };
}

function volatilityOf(analytics) {
  if (analytics.monthly.length < 3) return null;
  const model = linregForecast(analytics.monthly.map((m) => m.revenue));
  return model.mean ? Math.min(0.6, Math.abs(model.rmse / model.mean)) : null;
}

function riskLabel(months, cv) {
  if (cv == null) return "high";
  if (months >= 9 && cv < 0.15) return "low";
  if (months >= 5 && cv < 0.3) return "medium";
  return "high";
}

/** Shared assembler: given deltas in revenue/profit, builds the full
 *  current/scenario/impact/confidence response shape every simulate*
 *  function returns. */
function buildScenario(analytics, { dRevenue, dProfit, assumptions, label }) {
  const current = currentSnapshot(analytics);
  const scenarioRevenue = current.revenue + dRevenue;
  const scenarioProfit = current.profit + dProfit;
  const scenario = {
    revenue: round(scenarioRevenue),
    profit: round(scenarioProfit),
    marginPct: scenarioRevenue ? Number(((scenarioProfit / scenarioRevenue) * 100).toFixed(1)) : 0,
  };
  const cv = volatilityOf(analytics);
  const months = analytics.monthly.length;
  const risk = riskLabel(months, cv);
  const band = { low: round(dProfit - Math.abs(dProfit) * (cv ?? 0.4)), high: round(dProfit + Math.abs(dProfit) * (cv ?? 0.4)) };

  return {
    label,
    current,
    scenario,
    impact: {
      revenueDelta: round(dRevenue),
      profitDelta: round(dProfit),
      marginPPDelta: Number((scenario.marginPct - current.marginPct).toFixed(1)),
      profitDeltaRange: band,
    },
    assumptions,
    risk,
    confidence: risk === "low" ? "high" : risk === "medium" ? "medium" : "low",
    evidence: { transactions: analytics.count, monthsCovered: months },
  };
}

/** What if price changes by percentChange% (e.g. 5 for +5%)? Uses the
 *  dataset's own fitted elasticity when there's enough month-over-month
 *  price/quantity variation to trust one (analytics.priceElasticity.source
 *  === "estimated"); otherwise falls back to the stated 0.65 assumption. */
export function simulatePriceChange(analytics, percentChange = 0) {
  const elasticity = analytics.priceElasticity || { value: DEFAULT_PRICE_ELASTICITY, source: "assumption", monthsUsed: 0 };
  // Net revenue effect of a price move ≈ baseRevenue * %priceChange * (1 - elasticity):
  // the price effect minus the elasticity-driven volume loss it triggers.
  const netDRevenue = analytics.totals.revenue * (percentChange / 100) * (1 - elasticity.value);
  const dProfit = netDRevenue * (analytics.totals.margin / 100) * OPERATING_LEVERAGE;
  return buildScenario(analytics, {
    dRevenue: netDRevenue,
    dProfit,
    label: `Price ${percentChange >= 0 ? "+" : ""}${percentChange}%`,
    assumptions: {
      priceElasticity: { value: elasticity.value, source: elasticity.source, monthsUsed: elasticity.monthsUsed ?? 0 },
      note: "Net revenue effect = price change scaled by (1 - elasticity); most of it flows to profit (operating leverage assumption).",
    },
  });
}

/** What if price, marketing spend, and churn all move at once? This is
 *  what the frontend Decision Simulator's three sliders actually need —
 *  until now it reimplemented this combination itself, client-side, with
 *  its own copy of the elasticity constants and (worse) a fabricated
 *  "90% CI" band that was never derived from anything (fixed 0.55x/1.4x
 *  multipliers on whatever the sliders produced). This is the real,
 *  server-side, evidence-backed replacement: same elasticities as every
 *  other simulate* function (so a combined run and a single-lever run
 *  never disagree), and a `profitDeltaRange` built the same honest way
 *  buildScenario() already does everywhere else — from this dataset's own
 *  historical revenue volatility, explicitly NOT labeled as a formal
 *  confidence interval (see the `rangeMethodology` string below; nothing
 *  here justifies a specific statistical confidence level like "90%"). */
export function simulateLevers(analytics, { pricePct = 0, marketingPct = 0, churnPct = 0 } = {}) {
  const elasticity = analytics.priceElasticity || { value: DEFAULT_PRICE_ELASTICITY, source: "assumption", monthsUsed: 0 };

  const dRevPrice = analytics.totals.revenue * (pricePct / 100) * (1 - elasticity.value);
  const dRevMarketing = analytics.totals.revenue * (marketingPct / 100) * MARKETING_ELASTICITY;
  const dRevChurn = -analytics.totals.revenue * (churnPct / 100) * CHURN_ELASTICITY;
  const dRevenue = dRevPrice + dRevMarketing + dRevChurn;
  const dProfit = dRevenue * (analytics.totals.margin / 100) * OPERATING_LEVERAGE;
  const dCustomersPct = Number((-churnPct * 0.6 - marketingPct * 0.05).toFixed(1));

  const levers = [
    {
      lever: "price", inputPct: pricePct, revenueContribution: round(dRevPrice),
      source: elasticity.source, // "estimated" (fitted from this org's own price/quantity history) or "assumption" (stated 0.65)
      basis: elasticity.source === "estimated"
        ? `Estimated from ${elasticity.monthsUsed} months of this org's own price/quantity movements (fitted elasticity ${elasticity.value.toFixed(2)}).`
        : `No reliable price/quantity variation in this dataset to fit an elasticity from — using a stated assumption (${elasticity.value.toFixed(2)}), not a measured one.`,
    },
    {
      lever: "marketing", inputPct: marketingPct, revenueContribution: round(dRevMarketing),
      source: "assumption",
      basis: `The unified data model has no marketing-spend field to estimate an elasticity from — this is a stated assumption (${MARKETING_ELASTICITY}), the same one the AI Advisor's tools use, not a number fitted to this org's data.`,
    },
    {
      lever: "churn", inputPct: churnPct, revenueContribution: round(dRevChurn),
      source: "assumption",
      basis: `Churn's true revenue impact isn't reliably fittable from a short transaction history — this is a stated assumption (${CHURN_ELASTICITY}), not measured from this org's own churn behavior.`,
    },
  ];

  const scenario = buildScenario(analytics, {
    dRevenue, dProfit,
    label: `Price ${pricePct >= 0 ? "+" : ""}${pricePct}% · Marketing ${marketingPct >= 0 ? "+" : ""}${marketingPct}% · Churn ${churnPct >= 0 ? "+" : ""}${churnPct}%`,
    assumptions: { levers, estimatedCustomerImpactPct: dCustomersPct },
  });

  return {
    ...scenario,
    impact: {
      ...scenario.impact,
      customersDeltaPct: dCustomersPct,
      // Deliberately not called a "confidence interval" — see the module
      // header and rangeMethodology below. It's a heuristic band sized by
      // how much this business's own monthly revenue has historically
      // varied, nothing more rigorous than that.
      estimatedRange: scenario.impact.profitDeltaRange,
    },
    rangeMethodology:
      "This range is not a formal statistical confidence interval. It's sized by how much this org's own monthly revenue has " +
      "historically varied around its trend (wider range = more volatile/less history) — a heuristic sanity check on the point " +
      "estimate above it, not a probability guarantee.",
  };
}

/** What if COGS (unit cost) changes by percentChange% (negative = cost
 *  decreases)? Revenue is unaffected by construction — this only moves
 *  cost, and therefore profit, directly. */
export function simulateCostChange(analytics, percentChange = 0) {
  const baseCost = analytics.totals.revenue - analytics.totals.profit; // = total cost, derived from what's already in totals
  const dCost = baseCost * (percentChange / 100);
  const dProfit = -dCost;
  return buildScenario(analytics, {
    dRevenue: 0,
    dProfit,
    label: `COGS ${percentChange >= 0 ? "+" : ""}${percentChange}%`,
    assumptions: {
      note: "Assumes cost changes uniformly across the book (no mix shift) and revenue is unaffected — a cost lever, not a demand lever.",
      baseCost: round(baseCost),
    },
  });
}

/** What if churn changes by percentChange% (positive = churn increases)?
 *  Stated elasticity assumption (0.5) — churn's true revenue impact isn't
 *  reliably fittable from a short transaction history. */
export function simulateChurnChange(analytics, percentChange = 0) {
  const dRevenue = -analytics.totals.revenue * (percentChange / 100) * CHURN_ELASTICITY;
  const dProfit = dRevenue * (analytics.totals.margin / 100) * OPERATING_LEVERAGE;
  const dCustomersPct = -percentChange * 0.6;
  return buildScenario(analytics, {
    dRevenue,
    dProfit,
    label: `Churn ${percentChange >= 0 ? "+" : ""}${percentChange}%`,
    assumptions: { churnElasticity: { value: CHURN_ELASTICITY, source: "assumption" }, estimatedCustomerImpactPct: Number(dCustomersPct.toFixed(1)) },
  });
}

/** What if sales volume changes by percentChange% independent of price
 *  (e.g. demand shock, not a price move)? Assumes cost scales with revenue
 *  at the dataset's current cost ratio (no fixed/variable split modeled) —
 *  a stated simplification. */
export function simulateVolumeChange(analytics, percentChange = 0) {
  const dRevenue = analytics.totals.revenue * (percentChange / 100);
  const dProfit = dRevenue * (analytics.totals.margin / 100) * OPERATING_LEVERAGE;
  return buildScenario(analytics, {
    dRevenue,
    dProfit,
    label: `Volume ${percentChange >= 0 ? "+" : ""}${percentChange}%`,
    assumptions: { note: "Cost is assumed to scale with revenue at the current blended margin — no fixed/variable cost split is modeled yet." },
  });
}

/** What if we discontinue product `productName`? This is an EXACT
 *  what-if, not a statistical estimate: productIntelligence already holds
 *  that product's real revenue/profit for the loaded period, so removing
 *  it is a direct subtraction. The only assumption is that nothing else
 *  changes — no reallocation of freed capacity, no cannibalization by
 *  remaining products, no fixed-cost step-down. */
export function simulateDiscontinueProduct(analytics, productName) {
  const product = analytics.productIntelligence.find((p) => p.product === productName);
  if (!product) {
    return { error: `unknown product "${productName}" — call analyze_products or get_company_overview first to see valid product names` };
  }
  const dRevenue = -product.revenue;
  const dProfit = -product.profit;
  const current = currentSnapshot(analytics);
  const scenarioRevenue = current.revenue + dRevenue;
  const scenarioProfit = current.profit + dProfit;
  return {
    label: `Discontinue ${productName}`,
    current,
    scenario: {
      revenue: round(scenarioRevenue),
      profit: round(scenarioProfit),
      marginPct: scenarioRevenue ? Number(((scenarioProfit / scenarioRevenue) * 100).toFixed(1)) : 0,
    },
    impact: {
      revenueDelta: round(dRevenue),
      profitDelta: round(dProfit),
      marginPPDelta: Number(((scenarioRevenue ? (scenarioProfit / scenarioRevenue) * 100 : 0) - current.marginPct).toFixed(1)),
    },
    assumptions: {
      note: product.profit < 0
        ? "This product currently loses money — removing it is a direct, exact subtraction of its own numbers, assuming no reallocation of freed capacity to other products."
        : "This is an exact subtraction of the product's own revenue/profit, assuming no reallocation of freed capacity and no cannibalization by remaining products.",
    },
    risk: "low", // exact subtraction of real data, not a fitted estimate
    confidence: "high — this is a direct calculation from this product's actual figures, not a projection",
    evidence: { transactions: analytics.count, productShareOfRevenuePct: analytics.totals.revenue ? Number(((product.revenue / analytics.totals.revenue) * 100).toFixed(1)) : 0 },
  };
}
