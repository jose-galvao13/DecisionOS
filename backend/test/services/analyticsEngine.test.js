import { describe, it, expect } from "vitest";
import { computeAnalytics } from "../../src/services/analyticsEngine.js";

// Shape matches loadOrgTransactions()'s output — what computeAnalytics
// actually receives once the DB layer is stripped away.
function tx({ date, product = "Widget", region = "North", channel = "Online", customer = "Acme", quantity = 1, unitPrice = 100, discount = 0, cost = 40, currency }) {
  const revenue = unitPrice * quantity - discount;
  return { date: new Date(date), product, region, channel, customer, quantity, unitPrice, discount, revenue, cost, profit: revenue - cost, ...(currency ? { currency } : {}) };
}

describe("computeAnalytics", () => {
  it("returns null for an empty transaction list", () => {
    expect(computeAnalytics([])).toBeNull();
  });

  it("computes totals and margin correctly", () => {
    const txs = [
      tx({ date: "2024-01-05", unitPrice: 100, cost: 40 }),
      tx({ date: "2024-01-10", unitPrice: 200, cost: 80 }),
    ];
    const result = computeAnalytics(txs);
    expect(result.totals.revenue).toBe(300);
    expect(result.totals.profit).toBe(180);
    expect(result.totals.margin).toBeCloseTo(60, 5);
    expect(result.count).toBe(2);
  });

  it("groups monthly revenue/profit correctly across months", () => {
    const txs = [
      tx({ date: "2024-01-05", unitPrice: 100 }),
      tx({ date: "2024-02-05", unitPrice: 300 }),
      tx({ date: "2024-03-05", unitPrice: 200 }),
    ];
    const result = computeAnalytics(txs);
    expect(result.monthly.map((m) => m.key)).toEqual(["2024-01", "2024-02", "2024-03"]);
    expect(result.monthly[1].revenue).toBe(300);
  });

  it("breaks down revenue by product and region", () => {
    const txs = [
      tx({ date: "2024-01-01", product: "A", region: "North", unitPrice: 100 }),
      tx({ date: "2024-01-02", product: "B", region: "South", unitPrice: 50 }),
    ];
    const result = computeAnalytics(txs);
    expect(result.byProduct.find((p) => p.product === "A").revenue).toBe(100);
    expect(result.byRegion.find((r) => r.region === "South").value).toBe(50);
  });

  it("computes a forecast once there are at least 3 months of history", () => {
    const txs = ["2024-01-15", "2024-02-15", "2024-03-15", "2024-04-15"].map((d) => tx({ date: d, unitPrice: 100 }));
    const result = computeAnalytics(txs);
    expect(result.forecast).not.toBeNull();
    expect(result.forecast.months).toHaveLength(3);
    expect(["high", "medium", "low"]).toContain(result.forecast.confidence);
  });

  it("does not compute a forecast with fewer than 3 months", () => {
    const txs = [tx({ date: "2024-01-01" }), tx({ date: "2024-02-01" })];
    expect(computeAnalytics(txs).forecast).toBeNull();
  });

  it("flags customers with no second-half activity as churned", () => {
    const txs = [
      tx({ date: "2024-01-01", customer: "Loyal", unitPrice: 100 }),
      tx({ date: "2024-06-01", customer: "Loyal", unitPrice: 100 }),
      tx({ date: "2024-01-01", customer: "Ghost", unitPrice: 100 }),
    ];
    const result = computeAnalytics(txs);
    const ghostSegment = result.customerIntelligence.segments.churned.map((c) => c.customer);
    expect(ghostSegment).toContain("Ghost");
  });
});

describe("computeAnalytics — currency", () => {
  it("defaults to EUR when transactions have no currency field at all (older callers/fixtures)", () => {
    const txs = [tx({ date: "2024-01-05" }), tx({ date: "2024-01-10" })];
    const result = computeAnalytics(txs);
    expect(result.currency).toEqual({ primary: "EUR", distinct: ["EUR"], mixed: false, unconvertedCount: 0, unconvertedCurrencies: [] });
  });

  it("reports the single currency present as primary, not mixed", () => {
    const txs = [
      tx({ date: "2024-01-05", currency: "USD" }),
      tx({ date: "2024-01-10", currency: "USD" }),
    ];
    const result = computeAnalytics(txs);
    expect(result.currency).toEqual({ primary: "USD", distinct: ["USD"], mixed: false, unconvertedCount: 0, unconvertedCurrencies: [] });
  });

  it("flags mixed=true and picks the most frequent currency as primary", () => {
    const txs = [
      tx({ date: "2024-01-05", currency: "EUR" }),
      tx({ date: "2024-01-06", currency: "EUR" }),
      tx({ date: "2024-01-10", currency: "USD" }),
    ];
    const result = computeAnalytics(txs);
    expect(result.currency.mixed).toBe(true);
    expect(result.currency.primary).toBe("EUR"); // 2 EUR rows vs 1 USD row
    expect(result.currency.distinct.sort()).toEqual(["EUR", "USD"]);
  });

  it("surfaces unconvertedCount/unconvertedCurrencies for rows loadOrgTransactions couldn't convert (fxConverted: false)", () => {
    const txs = [
      tx({ date: "2024-01-05", currency: "EUR" }),
      { ...tx({ date: "2024-01-10", currency: "USD" }), fxConverted: false },
    ];
    const result = computeAnalytics(txs);
    expect(result.currency.unconvertedCount).toBe(1);
    expect(result.currency.unconvertedCurrencies).toEqual(["USD"]);
  });
});
