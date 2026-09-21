import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));
vi.mock("../../src/services/activeSource.js", () => ({
  getActiveDataSourceIds: vi.fn(async () => ["ds-active"]),
  setDataSourceActive: vi.fn(async () => {}),
}));

import { loadOrgTransactions } from "../../src/services/analyticsEngine.js";
import { getActiveDataSourceIds } from "../../src/services/activeSource.js";

function txRow(overrides = {}) {
  return {
    date: "2024-03-15", quantity: 2, unit_price: 100, discount: 0, net_revenue: 200, cost: 80, gross_profit: 120,
    currency: "EUR", customer: "Acme", product: "Widget", region: "North", channel: "Online",
    ...overrides,
  };
}

beforeEach(() => queryMock.mockReset());

describe("loadOrgTransactions — FX conversion", () => {
  it("leaves a transaction already in the org's default currency untouched, marked fxConverted", async () => {
    queryMock.mockResolvedValueOnce({ rows: [txRow({ currency: "EUR" })] });
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    const [t] = await loadOrgTransactions("org-A");
    expect(t.revenue).toBe(200);
    expect(t.currency).toBe("EUR");
    expect(t.fxConverted).toBe(true);
    expect(t.fxRate).toBe(1);
  });

  it("converts revenue/cost/profit using the rate in effect on the transaction's own date", async () => {
    queryMock.mockResolvedValueOnce({ rows: [txRow({ currency: "USD", net_revenue: 200, cost: 80, gross_profit: 120, unit_price: 100 })] });
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] });
    queryMock.mockResolvedValueOnce({ rows: [{ currency: "USD", rate_to_default: 0.9, effective_date: "2024-01-01" }] });
    const [t] = await loadOrgTransactions("org-A");
    expect(t.revenue).toBeCloseTo(180); // 200 * 0.9
    expect(t.cost).toBeCloseTo(72);
    expect(t.profit).toBeCloseTo(108);
    expect(t.unitPrice).toBeCloseTo(90);
    expect(t.currency).toBe("EUR"); // rewritten — this row is now genuinely in EUR
    expect(t.originalCurrency).toBe("USD");
    expect(t.fxConverted).toBe(true);
    expect(t.fxRate).toBe(0.9);
  });

  it("leaves a transaction unconverted (original currency, original amounts) when no fx_rate covers it", async () => {
    queryMock.mockResolvedValueOnce({ rows: [txRow({ currency: "JPY", net_revenue: 20000 })] });
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] });
    queryMock.mockResolvedValueOnce({ rows: [] }); // no rates at all
    const [t] = await loadOrgTransactions("org-A");
    expect(t.revenue).toBe(20000); // untouched
    expect(t.currency).toBe("JPY"); // NOT rewritten to EUR — would be a silent lie
    expect(t.fxConverted).toBe(false);
    expect(t.fxRate).toBeNull();
  });

  it("falls back to EUR as the default currency if the org row is somehow missing", async () => {
    queryMock.mockResolvedValueOnce({ rows: [txRow({ currency: "EUR" })] });
    queryMock.mockResolvedValueOnce({ rows: [] }); // organizations — nothing found
    queryMock.mockResolvedValueOnce({ rows: [] });
    const [t] = await loadOrgTransactions("org-A");
    expect(t.fxConverted).toBe(true); // EUR === fallback default EUR
  });
});


describe("loadOrgTransactions — active data source scoping", () => {
  it("only reads transactions of the org's active data source", async () => {
    getActiveDataSourceIds.mockResolvedValueOnce(["ds-2024"]);
    queryMock.mockResolvedValueOnce({ rows: [txRow()] });
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    await loadOrgTransactions("org-A");

    expect(getActiveDataSourceIds).toHaveBeenCalledWith("org-A");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/t\.data_source_id = ANY\(\$3\)/);
    expect(params).toEqual(["org-A", expect.any(Number), ["ds-2024"]]);
  });

  it("reads transactions from every active data source when several are active", async () => {
    getActiveDataSourceIds.mockResolvedValueOnce(["ds-2024", "ds-2025"]);
    queryMock.mockResolvedValueOnce({ rows: [txRow(), txRow({ net_revenue: 50, gross_profit: 20 })] });
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    const txs = await loadOrgTransactions("org-A");

    expect(txs).toHaveLength(2);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(["org-A", expect.any(Number), ["ds-2024", "ds-2025"]]);
  });

  it("returns no transactions, without touching the database, when the org has no usable source", async () => {
    getActiveDataSourceIds.mockResolvedValueOnce([]);
    expect(await loadOrgTransactions("org-A")).toEqual([]);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
