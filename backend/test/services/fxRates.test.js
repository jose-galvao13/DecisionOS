import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));
vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: vi.fn(async () => {}) }));

import { setRate, listRates, deleteRate, buildRateIndex, rateAsOf, FxRateError } from "../../src/services/fxRates.js";

beforeEach(() => queryMock.mockReset());

describe("setRate", () => {
  it("rejects a currency that isn't a 3-letter code", async () => {
    await expect(setRate("org-A", "u1", { currency: "US Dollar", rateToDefault: 0.9 })).rejects.toThrow(FxRateError);
  });

  it("rejects a non-positive rate", async () => {
    await expect(setRate("org-A", "u1", { currency: "USD", rateToDefault: -1 })).rejects.toThrow(/positive number/);
  });

  it("404s if the org doesn't exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // organizations lookup
    await expect(setRate("org-A", "u1", { currency: "USD", rateToDefault: 0.9 })).rejects.toThrow(FxRateError);
  });

  it("refuses a rate for the org's own default currency", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] });
    await expect(setRate("org-A", "u1", { currency: "eur", rateToDefault: 1 })).rejects.toThrow(/already EUR/);
  });

  it("upserts and returns the stored rate, uppercasing the currency code", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] }); // organizations
    queryMock.mockResolvedValueOnce({ rows: [{ id: "r1", org_id: "org-A", currency: "USD", rate_to_default: 0.92, effective_date: "2024-01-01" }] }); // insert
    const rate = await setRate("org-A", "u1", { currency: "usd", rateToDefault: 0.92, effectiveDate: "2024-01-01" });
    expect(rate.currency).toBe("USD");
    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toMatch(/ON CONFLICT/);
    expect(params[2]).toBe("USD");
  });
});

describe("listRates / deleteRate", () => {
  it("lists rates ordered by currency then most recent date", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "r1" }] });
    const rates = await listRates("org-A");
    expect(rates).toHaveLength(1);
  });

  it("404s deleting a rate that doesn't exist in this org", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await expect(deleteRate("org-A", "r1", "u1")).rejects.toThrow(FxRateError);
  });

  it("deletes and returns the removed rate", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "r1" }] });
    const deleted = await deleteRate("org-A", "r1", "u1");
    expect(deleted.id).toBe("r1");
  });
});

describe("buildRateIndex / rateAsOf", () => {
  it("returns null for a currency with no rates on file", () => {
    const index = buildRateIndex([]);
    expect(rateAsOf(index, "USD", new Date("2024-06-01"))).toBeNull();
  });

  it("picks the most recent rate at or before the given date", () => {
    const index = buildRateIndex([
      { currency: "USD", rate_to_default: 0.90, effective_date: "2024-01-01" },
      { currency: "USD", rate_to_default: 0.95, effective_date: "2024-06-01" },
    ]);
    expect(rateAsOf(index, "USD", new Date("2024-03-01"))).toBe(0.90);
    expect(rateAsOf(index, "USD", new Date("2024-06-01"))).toBe(0.95);
    expect(rateAsOf(index, "USD", new Date("2025-01-01"))).toBe(0.95);
  });

  it("falls back to the earliest known rate for a date before every rate on file", () => {
    const index = buildRateIndex([{ currency: "USD", rate_to_default: 0.90, effective_date: "2024-06-01" }]);
    expect(rateAsOf(index, "USD", new Date("2020-01-01"))).toBe(0.90);
  });

  it("rates for one currency don't leak into a lookup for another", () => {
    const index = buildRateIndex([
      { currency: "USD", rate_to_default: 0.90, effective_date: "2024-01-01" },
      { currency: "GBP", rate_to_default: 1.15, effective_date: "2024-01-01" },
    ]);
    expect(rateAsOf(index, "GBP", new Date("2024-06-01"))).toBe(1.15);
    expect(rateAsOf(index, "JPY", new Date("2024-06-01"))).toBeNull();
  });
});
