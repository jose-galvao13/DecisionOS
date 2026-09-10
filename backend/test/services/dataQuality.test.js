import { describe, it, expect } from "vitest";
import { assessQuality } from "../../src/services/dataQuality.js";

const mapping = { date: "Date", revenue: "Revenue", customer: "Customer", region: "Region" };

describe("assessQuality", () => {
  it("scores a clean dataset near 100", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      Date: `0${(i % 9) + 1}/01/2024`, Revenue: "100.00", Customer: `Customer ${i}`, Region: "North",
    }));
    const { score, issues } = assessQuality(rows, mapping);
    expect(score).toBeGreaterThan(95);
    // still reports the "valid revenue %" green line
    expect(issues.some((i) => i.code === "valid_revenue_pct")).toBe(true);
  });

  it("flags missing customer IDs as an issue, severity scaling with proportion", () => {
    const rows = [
      { Date: "01/01/2024", Revenue: "10", Customer: "A" },
      { Date: "01/01/2024", Revenue: "10", Customer: "" },
      { Date: "01/01/2024", Revenue: "10", Customer: "" },
    ];
    const { issues, score } = assessQuality(rows, mapping);
    const missing = issues.find((i) => i.code === "missing_customer_id");
    expect(missing).toBeTruthy();
    expect(missing.count).toBe(2);
    expect(missing.severity).toBe("red"); // 2/3 > 15%
    expect(score).toBeLessThan(100);
  });

  it("flags invalid dates and missing revenue independently", () => {
    const rows = [
      { Date: "not-a-date", Revenue: "10" },
      { Date: "01/01/2024", Revenue: "not-a-number" },
      { Date: "01/01/2024", Revenue: "10" },
    ];
    const { issues } = assessQuality(rows, mapping);
    expect(issues.find((i) => i.code === "invalid_dates").count).toBe(1);
    expect(issues.find((i) => i.code === "missing_revenue").count).toBe(1);
  });

  it("never returns a negative score even with a fully broken dataset", () => {
    const rows = [{ Date: "garbage", Revenue: "garbage", Customer: "" }];
    const { score } = assessQuality(rows, mapping);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("handles an empty dataset without throwing", () => {
    expect(() => assessQuality([], mapping)).not.toThrow();
  });

  it("flags mixed currencies as a red issue when a currency column is mapped", () => {
    const mappingWithCurrency = { ...mapping, currency: "Currency" };
    const rows = [
      { Date: "01/01/2024", Revenue: "10", Customer: "A", Currency: "EUR" },
      { Date: "01/01/2024", Revenue: "10", Customer: "B", Currency: "USD" },
      { Date: "01/01/2024", Revenue: "10", Customer: "C", Currency: "eur" }, // case-insensitive, same as EUR
    ];
    const { issues } = assessQuality(rows, mappingWithCurrency);
    const mixed = issues.find((i) => i.code === "mixed_currencies");
    expect(mixed).toBeTruthy();
    expect(mixed.severity).toBe("red");
    expect(mixed.count).toBe(2); // EUR + USD, "eur" folds into EUR
  });

  it("does not flag mixed currencies when every row uses the same currency", () => {
    const mappingWithCurrency = { ...mapping, currency: "Currency" };
    const rows = [
      { Date: "01/01/2024", Revenue: "10", Customer: "A", Currency: "EUR" },
      { Date: "01/01/2024", Revenue: "10", Customer: "B", Currency: "EUR" },
    ];
    const { issues } = assessQuality(rows, mappingWithCurrency);
    expect(issues.find((i) => i.code === "mixed_currencies")).toBeUndefined();
  });

  it("does not check currency at all when no currency column is mapped", () => {
    const rows = [
      { Date: "01/01/2024", Revenue: "10", Customer: "A" },
      { Date: "01/01/2024", Revenue: "10", Customer: "B" },
    ];
    const { issues } = assessQuality(rows, mapping); // mapping has no `currency` key
    expect(issues.find((i) => i.code === "mixed_currencies")).toBeUndefined();
  });
});
