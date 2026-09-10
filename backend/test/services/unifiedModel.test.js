import { describe, it, expect, vi, beforeEach } from "vitest";

// Same mocking pattern as test/services/decisionRecords.test.js: importRows
// runs everything inside withTransaction(client => ...), so the mock needs
// to hand back a client whose .query calls we can inspect, and run the
// callback for us.
const queryMock = vi.fn();
const fakeClient = { query: (...args) => queryMock(...args) };
vi.mock("../../src/db/pool.js", () => ({
  pool: { query: (...args) => queryMock(...args) },
  withTransaction: async (fn) => fn(fakeClient),
}));

import { importRows } from "../../src/services/unifiedModel.js";

beforeEach(() => queryMock.mockReset());

/** Every importRows() call issues, in order: DELETE prior transactions,
 *  SELECT organizations.default_currency, then per distinct dimension
 *  value an INSERT..ON CONFLICT (customers/products/regions/channels),
 *  then the chunked transactions INSERT, then the data_sources UPDATE.
 *  Tests below queue mocked results for just the calls each row set
 *  actually triggers. */
function queueCommonSetup({ orgDefaultCurrency = "EUR" } = {}) {
  queryMock.mockResolvedValueOnce({ rows: [] }); // DELETE
  queryMock.mockResolvedValueOnce({ rows: [{ default_currency: orgDefaultCurrency }] }); // org lookup
}

describe("importRows — currency handling", () => {
  it("stores gross_profit and currency on every inserted row (regression: both were previously missing from the INSERT column list)", async () => {
    queueCommonSetup({ orgDefaultCurrency: "USD" });
    // The transactions INSERT (this test's row has no dimension columns
    // mapped, so no dimensionResolver queries happen in between).
    queryMock.mockResolvedValueOnce({ rows: [] }); // transactions INSERT
    queryMock.mockResolvedValueOnce({ rows: [] }); // data_sources UPDATE

    const rows = [{ Date: "2024-01-01", Revenue: "100", Cost: "40" }];
    const mapping = { date: "Date", revenue: "Revenue", cost: "Cost" };

    await importRows({ orgId: "org-1", dataSourceId: "ds-1", rows, mapping });

    const insertCall = queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO transactions"));
    expect(insertCall).toBeTruthy();
    const [sql, params] = insertCall;
    expect(sql).toContain("gross_profit");
    expect(sql).toContain("currency");
    // params: id, org_id, data_source_id, date, customer_id, product_id,
    // region_id, channel_id, quantity, unit_price, gross_revenue,
    // discount, net_revenue, cost, gross_profit, currency (16 values)
    expect(params).toHaveLength(16);
    expect(params[13]).toBe(40); // cost
    expect(params[14]).toBe(60); // gross_profit = net_revenue(100) - cost(40)
    expect(params[15]).toBe("USD"); // org default, since no currency column mapped
  });

  it("uses the row's own mapped currency over the org default when present", async () => {
    queueCommonSetup({ orgDefaultCurrency: "EUR" });
    queryMock.mockResolvedValueOnce({ rows: [] }); // transactions INSERT
    queryMock.mockResolvedValueOnce({ rows: [] }); // data_sources UPDATE

    const rows = [{ Date: "2024-01-01", Revenue: "100", Currency: "gbp" }]; // lowercase on purpose
    const mapping = { date: "Date", revenue: "Revenue", currency: "Currency" };

    await importRows({ orgId: "org-1", dataSourceId: "ds-1", rows, mapping });

    const [, params] = queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO transactions"));
    expect(params[15]).toBe("GBP"); // normalized to uppercase, row wins over org default
  });

  it("falls back to the org's default_currency when the currency cell is blank", async () => {
    queueCommonSetup({ orgDefaultCurrency: "CHF" });
    queryMock.mockResolvedValueOnce({ rows: [] }); // transactions INSERT
    queryMock.mockResolvedValueOnce({ rows: [] }); // data_sources UPDATE

    const rows = [{ Date: "2024-01-01", Revenue: "100", Currency: "" }];
    const mapping = { date: "Date", revenue: "Revenue", currency: "Currency" };

    await importRows({ orgId: "org-1", dataSourceId: "ds-1", rows, mapping });

    const [, params] = queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO transactions"));
    expect(params[15]).toBe("CHF");
  });

  it("falls back to a hardcoded EUR only if the organization row itself can't be found", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // DELETE
    queryMock.mockResolvedValueOnce({ rows: [] }); // org lookup finds nothing
    queryMock.mockResolvedValueOnce({ rows: [] }); // transactions INSERT
    queryMock.mockResolvedValueOnce({ rows: [] }); // data_sources UPDATE

    const rows = [{ Date: "2024-01-01", Revenue: "100" }];
    const mapping = { date: "Date", revenue: "Revenue" };

    await importRows({ orgId: "org-missing", dataSourceId: "ds-1", rows, mapping });

    const [, params] = queryMock.mock.calls.find(([sql]) => sql.includes("INSERT INTO transactions"));
    expect(params[15]).toBe("EUR");
  });

  it("skips rows without a valid date or derivable revenue, and reports them as skipped", async () => {
    queueCommonSetup();
    queryMock.mockResolvedValueOnce({ rows: [] }); // data_sources UPDATE (no valid rows -> flush() is a no-op, no INSERT call)

    const rows = [
      { Date: "not-a-date", Revenue: "100" },
      { Date: "2024-01-01", Revenue: "not-a-number" },
    ];
    const mapping = { date: "Date", revenue: "Revenue" };

    const result = await importRows({ orgId: "org-1", dataSourceId: "ds-1", rows, mapping });
    expect(result).toEqual({ imported: 0, skipped: 2, total: 2 });
    expect(queryMock.mock.calls.some(([sql]) => sql.includes("INSERT INTO transactions"))).toBe(false);
  });
});
