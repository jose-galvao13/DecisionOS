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
import { computeWeights, computeConcentration } from "./portfolioAnalytics.js";
import { computePortfolioVaR95, MIN_OBSERVATIONS } from "./riskAnalytics.js";

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

/* ---------------------------------------------------------------
   PORTFOLIO — "what if I sold X% of this position?" (Parte 2, FASE 4)
----------------------------------------------------------------*/
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

export const PORTFOLIO_DISCLAIMER =
  "Analytical scenario about the risk profile of the portfolio. It does not recommend buying or selling anything and is not financial advice.";

function concentrationBlock(weighted) {
  const c = computeConcentration(weighted);
  return {
    hhi: r4(c.hhi),
    effectiveN: r2(c.effectiveN),
    top3: c.top3.map((p) => ({ ticker: p.ticker, nome: p.nome, pesoPct: r2(p.pesoPct) })),
    top3Pct: r2(c.top3Pct),
    largestPositionPct: c.top3.length ? r2(c.top3[0].pesoPct) : 0,
  };
}

function varBlock(v, coveredValue) {
  return {
    pct: v.var95Pct == null ? null : r2(v.var95Pct),
    amount: v.var95Pct == null ? null : r2((v.var95Pct / 100) * coveredValue),
    insufficientData: v.insufficientData,
    observations: v.observations,
    coveredWeightPct: r2(v.coveredWeightPct),
    coveredTickers: v.coveredTickers,
    excludedTickers: v.excludedTickers,
    from: v.from,
    to: v.to,
  };
}

/**
 * What if `percent`% of the position in `ticker` were sold? Returns the
 * weights, HHI (+ effective N, top 3) and historical VaR 95% BEFORE and
 * AFTER, and the deltas — the same current -> scenario -> impact shape
 * the other simulate* functions return.
 *
 * Pure: `portfolio` is buildPortfolioAnalytics()'s output (what
 * GET /api/portfolio/analytics returns) and `seriesByTicker` the
 * price_history closes ({ [ticker]: [{ data, fecho }] }) — see
 * services/portfolioData.js for the loader. Never throws for bad input:
 * like simulateDiscontinueProduct it returns { error } instead.
 *
 * Stated assumptions (also returned in `assumptions`):
 *   - the proceeds LEAVE the analysed portfolio (not held as cash, not
 *     reinvested): "after" describes the remaining holdings, i.e. what
 *     the Carteira page would show if the position were reduced in the
 *     imported file. Weights are re-based on the remaining value;
 *   - sold at the current price, no fees or taxes;
 *   - VaR uses the same historical method as the Risco tab, over the
 *     portfolio's weighted daily returns with constant weights, on the
 *     SAME sample window before and after, so the delta reflects the
 *     weights and nothing else. Positions without enough price history
 *     are left out of it (see var.coveredWeightPct) and currency moves
 *     against the base currency are not modelled.
 * Positions without a price/fx rate are outside every weight already
 * (portfolioAnalytics.js) and stay outside here.
 */
export function simulateSellPosition({ ticker, percent, portfolio, seriesByTicker = {}, minObservations = MIN_OBSERVATIONS } = {}) {
  const wanted = String(ticker ?? "").trim().toUpperCase();
  const pct = Number(percent);
  if (!wanted) return { error: "ticker is required" };
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return { error: "percent must be a number greater than 0 and at most 100" };
  if (!portfolio || !Array.isArray(portfolio.positions) || !portfolio.positions.length) {
    return { error: "no portfolio positions found — import a holdings file first" };
  }

  const target = portfolio.positions.find((p) => String(p.ticker).toUpperCase() === wanted);
  if (!target) {
    return { error: `unknown ticker "${wanted}" — valid tickers: ${portfolio.positions.map((p) => p.ticker).join(", ")}` };
  }
  if (target.semPreco) return { error: `${target.ticker} has no current price, so its weight in the portfolio is unknown — add a price first` };
  if (target.semTaxaCambio) return { error: `${target.ticker} is priced in ${target.moeda}, which has no exchange rate to ${portfolio.defaultCurrency} — add one first` };

  const sized = portfolio.positions
    .filter((p) => p.valorAtualConvertido != null)
    .map((p) => ({ ticker: p.ticker, nome: p.nome, moeda: p.moeda, valorAtualConvertido: p.valorAtualConvertido }));
  const factor = 1 - pct / 100;
  const afterSized = sized
    .map((p) => (p.ticker === target.ticker ? { ...p, valorAtualConvertido: p.valorAtualConvertido * factor } : p))
    .filter((p) => p.valorAtualConvertido > 1e-9);

  const beforeW = computeWeights(sized);
  const afterW = computeWeights(afterSized);
  const valuesOf = (list) => Object.fromEntries(list.map((p) => [p.ticker, p.valorAtualConvertido]));
  const totalOf = (list) => list.reduce((s, p) => s + p.valorAtualConvertido, 0);
  const totalBefore = totalOf(sized);
  const totalAfter = totalOf(afterSized);
  const proceeds = target.valorAtualConvertido * (pct / 100);

  const varBeforeRaw = computePortfolioVaR95(valuesOf(sized), seriesByTicker, { minObservations });
  const varAfterRaw = varBeforeRaw.insufficientData || !afterSized.length
    ? { ...varBeforeRaw, var95Pct: null, insufficientData: true, window: null }
    : computePortfolioVaR95(valuesOf(afterSized), seriesByTicker, { minObservations, window: varBeforeRaw.window });
  const coveredValue = (list, v) => list.filter((p) => v.coveredTickers.includes(p.ticker)).reduce((s, p) => s + p.valorAtualConvertido, 0);
  const varBefore = varBlock(varBeforeRaw, coveredValue(sized, varBeforeRaw));
  const varAfter = varBlock(varAfterRaw, coveredValue(afterSized, varAfterRaw));

  const current = { totalValue: r2(totalBefore), positions: sized.length, ...concentrationBlock(beforeW), var95: varBefore };
  const scenario = { totalValue: r2(totalAfter), positions: afterSized.length, ...concentrationBlock(afterW), var95: varAfter };

  const weightBefore = beforeW.find((p) => p.ticker === target.ticker)?.pesoPct ?? 0;
  const weightAfter = afterW.find((p) => p.ticker === target.ticker)?.pesoPct ?? 0;
  const afterByTicker = Object.fromEntries(afterW.map((p) => [p.ticker, p]));
  const weights = [...beforeW]
    .sort((a, b) => b.pesoPct - a.pesoPct)
    .map((p) => ({
      ticker: p.ticker,
      nome: p.nome,
      pesoBeforePct: r2(p.pesoPct),
      pesoAfterPct: r2(afterByTicker[p.ticker]?.pesoPct ?? 0),
      valueBefore: r2(p.valorAtualConvertido),
      valueAfter: r2(afterByTicker[p.ticker]?.valorAtualConvertido ?? 0),
    }));

  const bothVar = varBefore.pct != null && varAfter.pct != null;
  const warnings = [];
  const outside = portfolio.positions.filter((p) => p.valorAtualConvertido == null).map((p) => p.ticker);
  if (outside.length) {
    warnings.push({ code: "positions_outside", tickers: outside, message: `${outside.length} position(s) without a price or exchange rate are outside every weight and were not included.` });
  }
  if (sized.length === 1) {
    warnings.push({ code: "single_position", message: "This is the only priced position, so it weighs 100% before and after a partial sale; weights and HHI cannot change unless all of it is sold." });
  }
  if (varBefore.insufficientData) {
    warnings.push({ code: "var_insufficient_data", observations: varBefore.observations, minObservations, message: `Not enough price history to compute VaR (needs at least ${minObservations} daily returns common to the positions).` });
  } else if (varBefore.coveredWeightPct < 99.9) {
    warnings.push({ code: "var_partial_coverage", coveredWeightPct: varBefore.coveredWeightPct, tickers: varBefore.excludedTickers, message: `VaR covers ${varBefore.coveredWeightPct}% of the portfolio value; positions without enough price history are left out.` });
  }
  if (!varBefore.insufficientData) {
    const foreign = sized.filter((p) => varBeforeRaw.coveredTickers.includes(p.ticker) && p.moeda !== portfolio.defaultCurrency).map((p) => p.ticker);
    if (foreign.length) warnings.push({ code: "fx_not_modelled", tickers: foreign, message: `Returns of ${foreign.join(", ")} are in their own currency; currency moves against ${portfolio.defaultCurrency} are not modelled.` });
  }

  return {
    label: `Sell ${pct}% of ${target.ticker}`,
    ticker: target.ticker,
    nome: target.nome,
    percent: pct,
    currency: portfolio.defaultCurrency,
    proceeds: r2(proceeds),
    current,
    scenario,
    weights,
    impact: {
      valueDelta: r2(totalAfter - totalBefore),
      positionWeightDeltaPP: r2(weightAfter - weightBefore),
      hhiDelta: r4(scenario.hhi - current.hhi),
      effectiveNDelta: r2(scenario.effectiveN - current.effectiveN),
      largestPositionDeltaPP: r2(scenario.largestPositionPct - current.largestPositionPct),
      var95DeltaPP: bothVar ? r2(varAfter.pct - varBefore.pct) : null,
      var95AmountDelta: bothVar ? r2(varAfter.amount - varBefore.amount) : null,
    },
    assumptions: {
      proceeds: "removed_from_portfolio",
      priceBasis: "current_price_no_fees_no_taxes",
      varMethod: "historical_95_constant_weights_same_window",
      notes: [
        "The sale proceeds leave the analysed portfolio (they are neither held as cash nor reinvested): 'after' describes the remaining holdings, with weights re-based on their value.",
        "The position is sold at its current price, with no fees or taxes.",
        "VaR is the historical 95% VaR of the portfolio's weighted daily returns with constant weights, computed on the same sample window before and after so that the difference comes from the weights alone.",
        "Positions without enough price history are left out of VaR and currency moves against the base currency are not modelled.",
      ],
    },
    warnings,
    evidence: { positions: sized.length, priceObservations: varBefore.observations, window: { from: varBefore.from, to: varBefore.to } },
    disclaimer: PORTFOLIO_DISCLAIMER,
  };
}
