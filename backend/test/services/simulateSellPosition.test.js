import { describe, it, expect } from "vitest";
import { buildPortfolioAnalytics } from "../../src/services/portfolioAnalytics.js";
import { buildRateIndex } from "../../src/services/fxRates.js";
import { computePortfolioVaR95 } from "../../src/services/riskAnalytics.js";
import { simulateSellPosition } from "../../src/services/simulationEngine.js";

// Parte 2, FASE 4 — "vender X% de uma posição". Every number below is
// worked out by hand from small portfolios / short series.

function pos({ ticker, quantidade = 1, precoMedio = 1, precoAtual = null, moeda = "EUR", sector = null, pais = null, nome = null }) {
  return { ticker, nome, sector, pais, tipoAtivo: null, quantidade, precoMedio, precoAtual, moeda };
}
const portfolioOf = (positions, rates = []) =>
  buildPortfolioAnalytics(positions, { defaultCurrency: "EUR", rateIndex: buildRateIndex(rates) });

// 60/30/10 by value: A=600, B=300, C=100.
const abc = () => portfolioOf([
  pos({ ticker: "AAA", quantidade: 6, precoAtual: 100 }),
  pos({ ticker: "BBB", quantidade: 3, precoAtual: 100 }),
  pos({ ticker: "CCC", quantidade: 1, precoAtual: 100 }),
]);

// Consecutive-day series built from a list of daily returns (base price 100).
function series(returns) {
  let price = 100;
  const day = (i) => new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
  const out = [{ data: day(0), fecho: price }];
  returns.forEach((r, i) => { price *= 1 + r; out.push({ data: day(i + 1), fecho: price }); });
  return out;
}
const FLAT = Array(8).fill(0);
// AAA has one bad day (-10%) on day 3; the others never move.
const aaaReturns = [0.01, 0.01, -0.1, 0.01, 0.01, 0.01, 0.01, 0.01];
const seriesABC = () => ({ AAA: series(aaaReturns), BBB: series(FLAT), CCC: series(FLAT) });
const MIN = 5; // tests use short series, so the minimum sample is lowered

describe("simulateSellPosition — weights and HHI", () => {
  it("selling 50% of the 60% position: 60/30/10 -> 42.86/42.86/14.29, HHI 0.46 -> 0.3878", () => {
    const r = simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: abc(), seriesByTicker: {}, minObservations: MIN });
    expect(r.error).toBeUndefined();
    expect(r.current.totalValue).toBe(1000);
    expect(r.scenario.totalValue).toBe(700);
    expect(r.proceeds).toBe(300);
    expect(r.current.hhi).toBeCloseTo(0.46, 4);       // .36 + .09 + .01
    expect(r.scenario.hhi).toBeCloseTo(0.3878, 4);    // 2 * (3/7)^2 + (1/7)^2
    expect(r.current.effectiveN).toBeCloseTo(2.17, 2);
    expect(r.scenario.effectiveN).toBeCloseTo(2.58, 2);
    const a = r.weights.find((w) => w.ticker === "AAA");
    expect(a).toMatchObject({ pesoBeforePct: 60, pesoAfterPct: 42.86, valueBefore: 600, valueAfter: 300 });
    expect(r.impact.positionWeightDeltaPP).toBeCloseTo(-17.14, 2);
    expect(r.impact.hhiDelta).toBeCloseTo(-0.0722, 4);
    expect(r.impact.valueDelta).toBe(-300);
  });

  it("selling 100% removes the position: 60/30/10 -> 75/25, HHI 0.625, one position fewer", () => {
    const r = simulateSellPosition({ ticker: "aaa", percent: 100, portfolio: abc(), seriesByTicker: {}, minObservations: MIN });
    expect(r.ticker).toBe("AAA"); // case-insensitive lookup, canonical ticker back
    expect(r.scenario.positions).toBe(2);
    expect(r.scenario.hhi).toBeCloseTo(0.625, 4);
    expect(r.weights.find((w) => w.ticker === "AAA").pesoAfterPct).toBe(0);
    expect(r.weights.find((w) => w.ticker === "BBB").pesoAfterPct).toBe(75);
    expect(r.scenario.top3.map((p) => p.ticker)).toEqual(["BBB", "CCC"]);
  });

  it("does not mutate the portfolio it is given", () => {
    const p = abc();
    const snapshot = JSON.stringify(p);
    simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: p, seriesByTicker: seriesABC(), minObservations: MIN });
    expect(JSON.stringify(p)).toBe(snapshot);
  });

  it("a position without a price is outside the weights, and stays outside (with a warning)", () => {
    const p = portfolioOf([
      pos({ ticker: "AAA", quantidade: 6, precoAtual: 100 }),
      pos({ ticker: "BBB", quantidade: 4, precoAtual: 100 }),
      pos({ ticker: "DDD", quantidade: 50 }), // no price
    ]);
    const r = simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: p, seriesByTicker: {}, minObservations: MIN });
    expect(r.current.totalValue).toBe(1000);
    expect(r.weights.map((w) => w.ticker)).toEqual(["AAA", "BBB"]);
    expect(r.warnings.find((w) => w.code === "positions_outside").tickers).toEqual(["DDD"]);
  });

  it("with a single priced position a partial sale changes nothing (and says so)", () => {
    const p = portfolioOf([pos({ ticker: "AAA", quantidade: 10, precoAtual: 100 })]);
    const r = simulateSellPosition({ ticker: "AAA", percent: 40, portfolio: p, seriesByTicker: {}, minObservations: MIN });
    expect(r.current.hhi).toBe(1);
    expect(r.scenario.hhi).toBe(1);
    expect(r.impact.hhiDelta).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain("single_position");
  });
});

describe("simulateSellPosition — validation returns { error }, never throws", () => {
  const args = { portfolio: abc(), seriesByTicker: {}, minObservations: MIN };
  it("unknown ticker lists the valid ones", () => {
    const r = simulateSellPosition({ ticker: "ZZZ", percent: 10, ...args });
    expect(r.error).toMatch(/unknown ticker "ZZZ".*AAA, BBB, CCC/);
    expect(r.scenario).toBeUndefined();
  });
  it.each([[0], [-5], [101], [NaN], [undefined], ["abc"]])("rejects percent %s", (percent) => {
    expect(simulateSellPosition({ ticker: "AAA", percent, ...args }).error).toMatch(/percent/);
  });
  it("requires a ticker", () => {
    expect(simulateSellPosition({ percent: 10, ...args }).error).toMatch(/ticker is required/);
  });
  it("an empty portfolio has nothing to simulate", () => {
    expect(simulateSellPosition({ ticker: "AAA", percent: 10, portfolio: portfolioOf([]), seriesByTicker: {} }).error).toMatch(/no portfolio positions/);
    expect(simulateSellPosition({ ticker: "AAA", percent: 10 }).error).toMatch(/no portfolio positions/);
  });
  it("refuses to size a position that has no price, or no exchange rate", () => {
    const p = portfolioOf([
      pos({ ticker: "AAA", quantidade: 1, precoAtual: 100 }),
      pos({ ticker: "NOP", quantidade: 1 }),
      pos({ ticker: "USD1", quantidade: 1, precoAtual: 10, moeda: "USD" }), // no USD rate
    ]);
    expect(simulateSellPosition({ ticker: "NOP", percent: 10, portfolio: p }).error).toMatch(/no current price/);
    expect(simulateSellPosition({ ticker: "USD1", percent: 10, portfolio: p }).error).toMatch(/no exchange rate to EUR/);
  });
});

describe("computePortfolioVaR95", () => {
  it("is the 5th-percentile loss of the weighted daily returns (worst day when n < 20)", () => {
    // 60% in AAA, whose worst day is -10%; the rest never moves -> -6% on that day.
    const v = computePortfolioVaR95({ AAA: 600, BBB: 300, CCC: 100 }, seriesABC(), { minObservations: MIN });
    expect(v.insufficientData).toBe(false);
    expect(v.observations).toBe(8);
    expect(v.var95Pct).toBeCloseTo(6, 6);
    expect(v.coveredWeightPct).toBe(100);
    expect(v.from < v.to).toBe(true);
  });

  it("leaves out a ticker without enough history, renormalises, and reports the coverage", () => {
    const s = { ...seriesABC(), CCC: series([0.01]) }; // CCC has 1 return only
    const v = computePortfolioVaR95({ AAA: 600, BBB: 300, CCC: 100 }, s, { minObservations: MIN });
    expect(v.excludedTickers).toEqual(["CCC"]);
    expect(v.coveredTickers).toEqual(["AAA", "BBB"]);
    expect(v.coveredWeightPct).toBeCloseTo(90, 6);
    expect(v.var95Pct).toBeCloseTo(((600 / 900) * 10), 6); // AAA is 2/3 of what is covered
  });

  it("only uses dates every covered ticker has", () => {
    const a = series([...aaaReturns, 0.01, 0.01, 0.01, 0.01]);       // returns on days 1..12, bad day = day 3
    const b = series(Array(12).fill(0)).slice(4);                     // prices from day 4 -> returns on days 5..12
    const v = computePortfolioVaR95({ AAA: 1, BBB: 1 }, { AAA: a, BBB: b }, { minObservations: MIN });
    expect(v.observations).toBe(8);      // days 5..12 only
    expect(v.from).toBe("2024-01-06");   // day(5)
    expect(v.var95Pct).toBeLessThan(0);  // the -10% day (day 3) is outside the window: only gains left
  });

  it("says 'insufficient data' (null, not 0) under the minimum", () => {
    const v = computePortfolioVaR95({ AAA: 1 }, { AAA: series([0.01, -0.01]) }, { minObservations: MIN });
    expect(v.var95Pct).toBeNull();
    expect(v.insufficientData).toBe(true);
    const none = computePortfolioVaR95({ AAA: 1 }, {}, { minObservations: MIN });
    expect(none.var95Pct).toBeNull();
    expect(none.coveredWeightPct).toBe(0);
  });

  it("a given window forces the same tickers and dates", () => {
    const first = computePortfolioVaR95({ AAA: 600, BBB: 300, CCC: 100 }, seriesABC(), { minObservations: MIN });
    const again = computePortfolioVaR95({ AAA: 300, BBB: 300, CCC: 100 }, seriesABC(), { minObservations: MIN, window: first.window });
    expect(again.observations).toBe(first.observations);
    expect(again.var95Pct).toBeCloseTo((300 / 700) * 10, 6);
  });
});

describe("simulateSellPosition — VaR before/after", () => {
  it("selling 50% of AAA lowers VaR from 6.00% to 4.29% on the same window", () => {
    const r = simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: abc(), seriesByTicker: seriesABC(), minObservations: MIN });
    expect(r.current.var95.pct).toBeCloseTo(6, 2);
    expect(r.scenario.var95.pct).toBeCloseTo(4.29, 2); // 300/700 * 10
    expect(r.impact.var95DeltaPP).toBeCloseTo(-1.71, 2);
    expect(r.current.var95.amount).toBeCloseTo(60, 2);  // 6% of 1000
    expect(r.scenario.var95.amount).toBeCloseTo(30, 2); // 4.2857% of 700
    expect(r.impact.var95AmountDelta).toBeCloseTo(-30, 2);
    expect(r.scenario.var95.from).toBe(r.current.var95.from);
    expect(r.scenario.var95.to).toBe(r.current.var95.to);
    expect(r.evidence.window).toEqual({ from: r.current.var95.from, to: r.current.var95.to });
  });

  it("selling all of a position leaves the VaR of what remains (BBB/CCC never move -> 0)", () => {
    const r = simulateSellPosition({ ticker: "AAA", percent: 100, portfolio: abc(), seriesByTicker: seriesABC(), minObservations: MIN });
    expect(r.scenario.var95.pct).toBeCloseTo(0, 6);
    expect(r.impact.var95DeltaPP).toBeCloseTo(-6, 2);
  });

  it("without enough history VaR is null before AND after, weights/HHI still come back, and a warning says why", () => {
    const r = simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: abc(), seriesByTicker: { AAA: series([0.01]) }, minObservations: MIN });
    expect(r.current.var95.pct).toBeNull();
    expect(r.scenario.var95.pct).toBeNull();
    expect(r.current.var95.insufficientData).toBe(true);
    expect(r.impact.var95DeltaPP).toBeNull();
    expect(r.scenario.hhi).toBeCloseTo(0.3878, 4);
    expect(r.warnings.map((w) => w.code)).toContain("var_insufficient_data");
  });

  it("warns when VaR only covers part of the portfolio", () => {
    const s = { ...seriesABC(), CCC: series([0.01]) };
    const r = simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: abc(), seriesByTicker: s, minObservations: MIN });
    const w = r.warnings.find((x) => x.code === "var_partial_coverage");
    expect(w).toMatchObject({ coveredWeightPct: 90, tickers: ["CCC"] });
  });

  it("flags that currency moves are not modelled when a covered position is in another currency", () => {
    const p = portfolioOf([
      pos({ ticker: "AAA", quantidade: 6, precoAtual: 100 }),
      pos({ ticker: "USD1", quantidade: 4, precoAtual: 100, moeda: "USD" }),
    ], [{ currency: "USD", rate_to_default: 0.9, effective_date: "2024-01-01" }]);
    const r = simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: p, seriesByTicker: { AAA: series(aaaReturns), USD1: series(FLAT) }, minObservations: MIN });
    expect(r.current.totalValue).toBe(960); // 600 + 400*0.9
    expect(r.warnings.find((w) => w.code === "fx_not_modelled").tickers).toEqual(["USD1"]);
  });

  it("always carries its assumptions and the not-financial-advice notice", () => {
    const r = simulateSellPosition({ ticker: "AAA", percent: 50, portfolio: abc(), seriesByTicker: seriesABC(), minObservations: MIN });
    expect(r.assumptions.proceeds).toBe("removed_from_portfolio");
    expect(r.assumptions.notes.length).toBeGreaterThan(2);
    expect(r.disclaimer).toMatch(/not financial advice/i);
    expect(r.disclaimer).toMatch(/does not recommend/i);
  });
});
