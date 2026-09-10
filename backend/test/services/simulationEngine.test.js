import { describe, it, expect } from "vitest";
import { computeAnalytics } from "../../src/services/analyticsEngine.js";
import {
  simulatePriceChange, simulateCostChange, simulateVolumeChange, simulateDiscontinueProduct, simulateLevers,
} from "../../src/services/simulationEngine.js";

function tx({ date, product = "Widget", unitPrice = 100, cost = 40, quantity = 1 }) {
  const revenue = unitPrice * quantity;
  return { date: new Date(date), product, region: "North", channel: "Online", customer: "Acme", quantity, unitPrice, discount: 0, revenue, cost, profit: revenue - cost };
}

function fourMonthAnalytics(overrides = {}) {
  const txs = [];
  for (let m = 1; m <= 4; m++) {
    for (let i = 0; i < 5; i++) txs.push(tx({ date: `2024-0${m}-1${i}`, ...overrides }));
  }
  return computeAnalytics(txs);
}

describe("simulateCostChange", () => {
  it("a cost decrease increases profit and holds revenue fixed", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateCostChange(analytics, -10); // 10% cheaper COGS
    expect(result.scenario.revenue).toBe(result.current.revenue); // pure cost lever
    expect(result.scenario.profit).toBeGreaterThan(result.current.profit);
    expect(result.impact.profitDelta).toBeGreaterThan(0);
  });

  it("a cost increase decreases profit", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateCostChange(analytics, 10);
    expect(result.scenario.profit).toBeLessThan(result.current.profit);
    expect(result.impact.profitDelta).toBeLessThan(0);
  });
});

describe("simulateVolumeChange", () => {
  it("scales revenue with volume", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateVolumeChange(analytics, 20); // +20% volume
    expect(result.scenario.revenue).toBeCloseTo(result.current.revenue * 1.2, 0);
  });
});

describe("simulateDiscontinueProduct", () => {
  it("is an exact subtraction of that product's revenue/profit, not an estimate", () => {
    const txs = [
      ...Array.from({ length: 4 }, (_, i) => tx({ date: `2024-0${i + 1}-05`, product: "A", unitPrice: 100 })),
      ...Array.from({ length: 4 }, (_, i) => tx({ date: `2024-0${i + 1}-06`, product: "B", unitPrice: 50 })),
    ];
    const analytics = computeAnalytics(txs);
    const result = simulateDiscontinueProduct(analytics, "A");
    const productA = analytics.productIntelligence.find((p) => p.product === "A");
    expect(result.impact.revenueDelta).toBeCloseTo(-productA.revenue, 0);
    expect(result.scenario.revenue).toBeCloseTo(analytics.totals.revenue - productA.revenue, 0);
    expect(result.risk).toBe("low"); // exact calc, not a statistical estimate
  });

  it("returns a clear error (not a thrown exception or a silently wrong number) for an unknown product", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateDiscontinueProduct(analytics, "Does Not Exist");
    expect(result.error).toMatch(/unknown product/i);
    expect(result.scenario).toBeUndefined();
  });
});

describe("simulatePriceChange", () => {
  it("labels the elasticity source as either 'estimated' or 'assumption', never silently unlabeled", () => {
    const analytics = fourMonthAnalytics();
    const result = simulatePriceChange(analytics, 5);
    expect(["estimated", "assumption"]).toContain(result.assumptions.priceElasticity.source);
  });

  it("a price increase under inelastic demand raises net revenue", () => {
    const analytics = fourMonthAnalytics();
    // Force the assumption path deterministically regardless of fitted elasticity.
    analytics.priceElasticity = { value: 0.3, source: "assumption", monthsUsed: 0 };
    const result = simulatePriceChange(analytics, 10);
    expect(result.impact.revenueDelta).toBeGreaterThan(0);
  });
});

describe("simulateLevers — P0 credibility fix (replaces the frontend's fabricated 90% CI)", () => {
  it("combines price/marketing/churn additively and matches the sum of their individual revenue contributions", () => {
    const analytics = fourMonthAnalytics();
    analytics.priceElasticity = { value: 0.5, source: "assumption", monthsUsed: 0 };
    const result = simulateLevers(analytics, { pricePct: 5, marketingPct: 10, churnPct: 2 });
    const sumOfLevers = result.assumptions.levers.reduce((s, l) => s + l.revenueContribution, 0);
    expect(result.impact.revenueDelta).toBeCloseTo(sumOfLevers, 0);
  });

  it("every lever states its source (estimated/assumption) and a plain-language basis — never a bare number", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateLevers(analytics, { pricePct: 5, marketingPct: 5, churnPct: 5 });
    for (const lever of result.assumptions.levers) {
      expect(["estimated", "assumption"]).toContain(lever.source);
      expect(typeof lever.basis).toBe("string");
      expect(lever.basis.length).toBeGreaterThan(20);
    }
    // marketing and churn can never be "estimated" — there's no marketing-spend
    // or reliable churn-elasticity data in the unified model to fit them from.
    const marketing = result.assumptions.levers.find((l) => l.lever === "marketing");
    const churn = result.assumptions.levers.find((l) => l.lever === "churn");
    expect(marketing.source).toBe("assumption");
    expect(churn.source).toBe("assumption");
  });

  it("never claims a specific confidence level (e.g. '90% CI') it can't justify", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateLevers(analytics, { pricePct: 5, marketingPct: 0, churnPct: 0 });
    expect(result.rangeMethodology.toLowerCase()).not.toMatch(/90%/);
    expect(result.rangeMethodology.toLowerCase()).toMatch(/not a formal statistical confidence interval/);
    expect(result.impact.estimatedRange).toBeTruthy();
    expect(result.impact.estimatedRange).toHaveProperty("low");
    expect(result.impact.estimatedRange).toHaveProperty("high");
  });

  it("surfaces confidence and data coverage (transactions/months), same discipline as every other simulate* function", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateLevers(analytics, { pricePct: 5, marketingPct: 0, churnPct: 0 });
    expect(["low", "medium", "high"]).toContain(result.confidence);
    expect(result.evidence.transactions).toBe(analytics.count);
    expect(result.evidence.monthsCovered).toBe(analytics.monthly.length);
  });

  it("all-zero levers produce a zero-impact scenario (identity case)", () => {
    const analytics = fourMonthAnalytics();
    const result = simulateLevers(analytics, { pricePct: 0, marketingPct: 0, churnPct: 0 });
    expect(result.impact.revenueDelta).toBe(0);
    expect(result.impact.profitDelta).toBe(0);
  });
});
