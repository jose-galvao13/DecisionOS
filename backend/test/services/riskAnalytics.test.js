import { describe, it, expect } from "vitest";
import {
  computeDailyReturns,
  stddev,
  annualizedVolatility,
  drawdownCurve,
  maxDrawdown,
  historicalVaR95,
  correlation,
  beta,
  buildRiskAnalytics,
  MIN_OBSERVATIONS,
} from "../../src/services/riskAnalytics.js";

/** Builds a synthetic price series of `n` days starting at `start`, with a
 *  deterministic oscillation so it has real (non-zero) volatility/drawdown
 *  instead of a flat line. */
function series(n, { start = 100, dateFrom = "2024-01-01", wobble = 0.01 } = {}) {
  const out = [];
  let price = start;
  let d = new Date(dateFrom);
  for (let i = 0; i < n; i++) {
    out.push({ data: d.toISOString().slice(0, 10), fecho: price });
    price = price * (1 + Math.sin(i / 3) * wobble);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

describe("computeDailyReturns", () => {
  it("returns n-1 returns for n prices, sorted ascending regardless of input order", () => {
    const prices = [
      { data: "2024-01-03", fecho: 110 },
      { data: "2024-01-01", fecho: 100 },
      { data: "2024-01-02", fecho: 105 },
    ];
    const rets = computeDailyReturns(prices);
    expect(rets).toHaveLength(2);
    expect(rets[0]).toEqual({ data: "2024-01-02", ret: 0.05 });
    expect(rets[1].data).toBe("2024-01-03");
  });

  it("returns an empty array for fewer than 2 prices", () => {
    expect(computeDailyReturns([{ data: "2024-01-01", fecho: 100 }])).toEqual([]);
    expect(computeDailyReturns([])).toEqual([]);
  });
});

describe("stddev", () => {
  it("is null for an empty array, 0 for a single value", () => {
    expect(stddev([])).toBeNull();
    expect(stddev([5])).toBe(0);
  });

  it("matches a hand-computed sample stdev", () => {
    // values: 2,4,4,4,5,5,7,9 -> mean 5, sample variance 4.57142..., sd ~2.1381
    const v = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stddev(v)).toBeCloseTo(2.13809, 4);
  });
});

describe("annualizedVolatility", () => {
  it("scales the sample stdev of returns by sqrt(252)", () => {
    const returns = [0.01, -0.01, 0.02, -0.02, 0.01];
    expect(annualizedVolatility(returns)).toBeCloseTo(stddev(returns) * Math.sqrt(252), 10);
  });
});

describe("drawdownCurve / maxDrawdown", () => {
  it("is all zeros for a monotonically rising series", () => {
    const prices = [1, 2, 3, 4, 5].map((fecho, i) => ({ data: `2024-01-0${i + 1}`, fecho }));
    const curve = drawdownCurve(prices);
    expect(curve.every((c) => c.drawdown === 0)).toBe(true);
    expect(maxDrawdown(prices)).toBe(0);
  });

  it("computes the correct peak-to-trough fraction for a simple down-then-up series", () => {
    // 100 -> 80 (peak 100, -20%) -> 90 (still -10% off peak) -> 120 (new peak, dd 0)
    const prices = [
      { data: "2024-01-01", fecho: 100 },
      { data: "2024-01-02", fecho: 80 },
      { data: "2024-01-03", fecho: 90 },
      { data: "2024-01-04", fecho: 120 },
    ];
    const curve = drawdownCurve(prices);
    expect(curve.map((c) => c.drawdown)).toEqual([0, -0.2, -0.1, 0]);
    expect(maxDrawdown(prices)).toBe(-0.2);
  });

  it("returns null for maxDrawdown on an empty series", () => {
    expect(maxDrawdown([])).toBeNull();
  });
});

describe("historicalVaR95", () => {
  it("picks the empirical 5th-percentile loss (nearest-rank), sign flipped positive", () => {
    // 20 returns, worst is -0.10 at index 0 after sorting ascending;
    // 5th percentile index = floor(0.05*20) = 1 -> second-worst return.
    const returns = [-0.10, -0.08, -0.05, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03,
                      0.01, 0.02, 0.015, -0.005, 0.005, 0.012, -0.012, 0.008, -0.008, 0.02];
    const sorted = [...returns].sort((a, b) => a - b);
    expect(historicalVaR95(returns)).toBeCloseTo(-sorted[1], 10);
  });

  it("is null for an empty return series", () => {
    expect(historicalVaR95([])).toBeNull();
  });
});

describe("correlation", () => {
  it("is 1 for two identical series and null for a constant series", () => {
    expect(correlation([0.01, 0.02, -0.01, 0.03], [0.01, 0.02, -0.01, 0.03])).toBeCloseTo(1, 10);
    expect(correlation([0.01, 0.01, 0.01], [0.01, 0.02, -0.01])).toBeNull(); // zero-variance series
  });

  it("is -1 for perfectly inverted series", () => {
    expect(correlation([0.01, 0.02, -0.01, 0.03], [-0.01, -0.02, 0.01, -0.03])).toBeCloseTo(-1, 10);
  });

  it("is null with fewer than 2 paired observations", () => {
    expect(correlation([0.01], [0.02])).toBeNull();
  });
});

describe("beta", () => {
  it("is ~2 when the asset return is exactly 2x the index return", () => {
    const index = [0.01, -0.02, 0.03, 0.005, -0.01];
    const asset = index.map((r) => r * 2);
    expect(beta(asset, index)).toBeCloseTo(2, 10);
  });

  it("is null when the index has zero variance", () => {
    expect(beta([0.01, 0.02, -0.01], [0.01, 0.01, 0.01])).toBeNull();
  });
});

describe("buildRiskAnalytics — insufficient data threshold", () => {
  it("flags a ticker with fewer than MIN_OBSERVATIONS returns as insufficientData, with null metrics", () => {
    const short = series(30); // 29 returns < 60
    const out = buildRiskAnalytics({ AAA: short });
    expect(out.perTicker.AAA.observations).toBe(29);
    expect(out.perTicker.AAA.insufficientData).toBe(true);
    expect(out.perTicker.AAA.volatilidadeAnualizada).toBeNull();
    expect(out.perTicker.AAA.var95Pct).toBeNull();
    // Drawdown doesn't need the observation minimum — it's still computed.
    expect(out.perTicker.AAA.maxDrawdownPct).not.toBeNull();
  });

  it("computes full metrics once at/above MIN_OBSERVATIONS", () => {
    const long = series(MIN_OBSERVATIONS + 5);
    const out = buildRiskAnalytics({ AAA: long });
    expect(out.perTicker.AAA.observations).toBeGreaterThanOrEqual(MIN_OBSERVATIONS);
    expect(out.perTicker.AAA.insufficientData).toBe(false);
    expect(out.perTicker.AAA.volatilidadeAnualizada).not.toBeNull();
    expect(out.perTicker.AAA.var95Pct).not.toBeNull();
  });
});

describe("buildRiskAnalytics — beta vs. an index series", () => {
  it("computes beta only for tickers other than the index, and leaves it null without enough overlap", () => {
    const base = series(MIN_OBSERVATIONS + 10);
    const asset = base;
    const index = base.map((p) => ({ data: p.data, fecho: p.fecho * 0.5 + 50 }));
    const out = buildRiskAnalytics({ AAA: asset, IDX: index }, { indexTicker: "IDX" });

    expect(out.perTicker.IDX.beta).toBeNull(); // the index itself is never beta'd against itself
    expect(out.perTicker.AAA.beta).not.toBeNull();
    expect(out.perTicker.AAA.betaInsufficientData).toBe(false);
  });

  it("leaves beta null (and flags betaInsufficientData) when overlap is below the minimum", () => {
    const asset = series(MIN_OBSERVATIONS + 10, { dateFrom: "2024-01-01" });
    // Index series starts far later — little/no date overlap with `asset`.
    const index = series(MIN_OBSERVATIONS + 10, { dateFrom: "2030-01-01" });
    const out = buildRiskAnalytics({ AAA: asset, IDX: index }, { indexTicker: "IDX" });
    expect(out.perTicker.AAA.beta).toBeNull();
    expect(out.perTicker.AAA.betaInsufficientData).toBe(true);
  });

  it("has betaInsufficientData: null (n/a) when no indexTicker is configured", () => {
    const out = buildRiskAnalytics({ AAA: series(70) });
    expect(out.perTicker.AAA.beta).toBeNull();
    expect(out.perTicker.AAA.betaInsufficientData).toBeNull();
  });
});

describe("buildRiskAnalytics — correlation matrix", () => {
  it("is 1 on the diagonal and symmetric off it", () => {
    const a = series(70, { dateFrom: "2024-01-01" });
    const b = series(70, { dateFrom: "2024-01-01", wobble: 0.02 });
    const out = buildRiskAnalytics({ AAA: a, BBB: b });
    expect(out.correlationMatrix.AAA.AAA).toBe(1);
    expect(out.correlationMatrix.BBB.BBB).toBe(1);
    expect(out.correlationMatrix.AAA.BBB).toBeCloseTo(out.correlationMatrix.BBB.AAA, 10);
  });
});
