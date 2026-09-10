import { describe, it, expect } from "vitest";
import { computeAnalytics } from "../../src/services/analyticsEngine.js";
import { generateDecisions } from "../../src/services/decisionEngine.js";

// Building `analytics` via the real analyticsEngine (rather than hand-rolling
// the shape decisionEngine expects) keeps this test honest about the actual
// Analytics Engine -> Decision Engine contract, and would break loudly if
// that contract ever drifted.
function tx({ date, product = "Widget", region = "North", channel = "Online", customer = "Acme", quantity = 1, unitPrice = 100, cost = 40, currency }) {
  const revenue = unitPrice * quantity;
  return { date: new Date(date), product, region, channel, customer, quantity, unitPrice, discount: 0, revenue, cost, profit: revenue - cost, ...(currency ? { currency } : {}) };
}

describe("generateDecisions", () => {
  it("returns [] for null analytics", () => {
    expect(generateDecisions(null)).toEqual([]);
  });

  it("returns [] when nothing crosses a materiality threshold", () => {
    // Flat, healthy business — identical daily revenue over ~200 days.
    // analyticsEngine.js splits 1st/2nd half by transaction *date*
    // (floor(n/2)), and ties (same day) all land in the first half — so
    // with an even day count there's always one extra day tipped into
    // "first". A long enough run dilutes that single-day skew to well
    // under a percent, instead of chasing an exact split that doesn't
    // exist in this algorithm.
    const txs = [];
    const start = new Date(Date.UTC(2024, 0, 1));
    for (let day = 0; day < 500; day++) {
      const date = new Date(start.getTime() + day * 86400000).toISOString().slice(0, 10);
      for (let k = 0; k < 3; k++) txs.push(tx({ date, unitPrice: 100, cost: 40, customer: `C${k}` }));
    }
    const analytics = computeAnalytics(txs);
    expect(Math.abs(analytics.deltas.revenue)).toBeLessThan(1); // sanity: this dataset really is flat
    const decisions = generateDecisions(analytics);
    expect(decisions.find((d) => d.type === "revenue_decline")).toBeUndefined();
  });

  it("detects a material revenue decline and ranks it by severity", () => {
    const txs = [
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-01-${10 + (i % 15)}`, unitPrice: 500 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-02-${10 + (i % 15)}`, unitPrice: 500 })),
      // second half collapses
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-03-${10 + (i % 15)}`, unitPrice: 50 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-04-${10 + (i % 15)}`, unitPrice: 50 })),
    ];
    const analytics = computeAnalytics(txs);
    const decisions = generateDecisions(analytics);
    const decline = decisions.find((d) => d.type === "revenue_decline");
    expect(decline).toBeTruthy();
    expect(decline.severity).toBe("red");
    expect(decline.confidence).toBeGreaterThan(0);
    expect(decline.confidence).toBeLessThanOrEqual(100);
    // every decision must carry evidence it can show its work with
    expect(decline.evidence).toBeTruthy();
    expect(Array.isArray(decline.drivers)).toBe(true);
  });

  it("labels impact currency from the transactions' own currency, not a hardcoded EUR (regression)", () => {
    const txs = [
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-01-${10 + (i % 15)}`, unitPrice: 500, currency: "USD" })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-02-${10 + (i % 15)}`, unitPrice: 500, currency: "USD" })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-03-${10 + (i % 15)}`, unitPrice: 50, currency: "USD" })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-04-${10 + (i % 15)}`, unitPrice: 50, currency: "USD" })),
    ];
    const analytics = computeAnalytics(txs);
    const decline = generateDecisions(analytics).find((d) => d.type === "revenue_decline");
    expect(decline.impact.currency).toBe("USD");
  });

  it("falls back to EUR when the transactions carry no currency at all", () => {
    const txs = [
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-01-${10 + (i % 15)}`, unitPrice: 500 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-02-${10 + (i % 15)}`, unitPrice: 500 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-03-${10 + (i % 15)}`, unitPrice: 50 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-04-${10 + (i % 15)}`, unitPrice: 50 })),
    ];
    const analytics = computeAnalytics(txs);
    const decline = generateDecisions(analytics).find((d) => d.type === "revenue_decline");
    expect(decline.impact.currency).toBe("EUR");
  });

  it("sorts decisions red before yellow before green, ties by confidence", () => {
    const txs = [
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-01-${10 + (i % 15)}`, unitPrice: 500, cost: 100 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-02-${10 + (i % 15)}`, unitPrice: 500, cost: 100 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-03-${10 + (i % 15)}`, unitPrice: 60, cost: 100 })),
      ...Array.from({ length: 10 }, (_, i) => tx({ date: `2024-04-${10 + (i % 15)}`, unitPrice: 60, cost: 100 })),
    ];
    const analytics = computeAnalytics(txs);
    const decisions = generateDecisions(analytics);
    const rank = { red: 2, yellow: 1, green: 0 };
    for (let i = 1; i < decisions.length; i++) {
      expect(rank[decisions[i - 1].severity]).toBeGreaterThanOrEqual(rank[decisions[i].severity]);
    }
  });

  it("never throws even if one detector's precondition is unmet (customer risk needs a customer field)", () => {
    const txs = [tx({ date: "2024-01-01" }), tx({ date: "2024-02-01" })];
    const analytics = computeAnalytics(txs);
    expect(() => generateDecisions(analytics)).not.toThrow();
  });
});
