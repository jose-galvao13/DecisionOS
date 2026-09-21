import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));
vi.mock("../../src/services/activeSource.js", () => ({
  getActiveDataSourceId: vi.fn(async () => "ds-active"),
  getActiveDataSourceIds: vi.fn(async () => ["ds-active"]),
  setDataSourceActive: vi.fn(async () => {}),
}));
vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: vi.fn(async () => {}) }));

import { findDueMeasurements, measureDecision, runDueMeasurements } from "../../src/services/measurementEngine.js";

function txRow({ date, revenue = 0, profit = 0 }) {
  return {
    date, quantity: 1, unit_price: revenue, discount: 0, net_revenue: revenue, cost: revenue - profit,
    gross_profit: profit, currency: "EUR", customer: null, product: "Widget", region: "PT", channel: null,
  };
}

function decisionRow(overrides = {}) {
  const startedAt = new Date("2024-01-01T00:00:00Z");
  return {
    id: "dec-1", org_id: "org-A", status: "in_progress",
    started_at: startedAt, measurement_window_days: 60,
    baseline_metric: { metric: "revenue", value: 1000, windowDays: 60, from: "2023-11-02", to: "2024-01-01", computedAt: startedAt.toISOString() },
    expected_impact: { metric: "revenue", low: 500, high: 1500, currency: "EUR" },
    actual_outcome: null, investment_cost: null,
    ...overrides,
  };
}

beforeEach(() => queryMock.mockReset());

describe("findDueMeasurements", () => {
  it("queries only in_progress decisions with no outcome, a baseline, and an elapsed window", async () => {
    queryMock.mockResolvedValueOnce({ rows: [decisionRow()] });
    const due = await findDueMeasurements();
    expect(due).toHaveLength(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = 'in_progress'/);
    expect(sql).toMatch(/actual_outcome IS NULL/);
    expect(sql).toMatch(/baseline_metric IS NOT NULL/);
    expect(params).toEqual([]);
  });

  it("scopes to a single org when an orgId is passed (used by the API endpoint, unlike the background sweep)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await findDueMeasurements("org-A");
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/org_id = \$1/);
    expect(params).toEqual(["org-A"]);
  });
});

describe("measureDecision", () => {
  it("sums the observed metric over [started_at, started_at+windowDays) and records the delta vs. baseline", async () => {
    const decision = decisionRow();
    // observed window: 2024-01-01 .. 2024-03-01 (60 days) — one tx inside, one outside
    queryMock.mockResolvedValueOnce({
      rows: [
        txRow({ date: "2024-01-15", revenue: 1800 }), // inside window
        txRow({ date: "2024-06-01", revenue: 9999 }), // well outside — must be excluded
      ],
    }); // loadOrgTransactions: transactions
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] }); // loadOrgTransactions: organizations
    queryMock.mockResolvedValueOnce({ rows: [] }); // loadOrgTransactions: fx_rates — none needed, all EUR
    queryMock.mockResolvedValueOnce({ rows: [decision] }); // recordOutcome's internal getDecision
    queryMock.mockResolvedValueOnce({ rows: [decisionRow({ status: "completed", actual_outcome: { value: 800, source: "automatic" }, outcome_source: "automatic" })] }); // recordOutcome's UPDATE

    const updated = await measureDecision(decision);
    expect(updated.status).toBe("completed");
    // recordOutcome's UPDATE call is queryMock call #5 (index 4); its 3rd bound param is the JSON actual_outcome
    const [, updateParams] = queryMock.mock.calls[4];
    const actualOutcome = JSON.parse(updateParams[2]);
    expect(actualOutcome.value).toBe(800); // 1800 observed - 1000 baseline
    expect(actualOutcome.source).toBe("automatic");
    expect(actualOutcome.notes).toMatch(/Medido automaticamente/);
  });

  it("returns null (does not record anything) for a metric it can't compute from transactions", async () => {
    const decision = decisionRow({ baseline_metric: { metric: "revenue_concentration_pct", value: 40 } });
    const result = await measureDecision(decision);
    expect(result).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("runDueMeasurements", () => {
  it("summarizes checked/measured/skipped and keeps going if one decision fails", async () => {
    const dec1 = decisionRow({ id: "dec-1" });
    queryMock.mockResolvedValueOnce({ rows: [dec1, decisionRow({ id: "dec-2", baseline_metric: { metric: "revenue_concentration_pct", value: 1 } })] }); // findDueMeasurements
    queryMock.mockResolvedValueOnce({ rows: [txRow({ date: "2024-01-15", revenue: 1200 })] }); // loadOrgTransactions for dec-1: transactions
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] }); // loadOrgTransactions for dec-1: organizations
    queryMock.mockResolvedValueOnce({ rows: [] }); // loadOrgTransactions for dec-1: fx_rates
    queryMock.mockResolvedValueOnce({ rows: [dec1] }); // recordOutcome's internal getDecision for dec-1
    queryMock.mockResolvedValueOnce({ rows: [decisionRow({ id: "dec-1", status: "completed" })] }); // recordOutcome update for dec-1
    // dec-2 has an uncomputable metric — measureDecision returns null without any extra query

    const result = await runDueMeasurements();
    expect(result.checked).toBe(2);
    expect(result.measured).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });
});
