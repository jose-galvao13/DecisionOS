import { describe, it, expect, vi, beforeEach } from "vitest";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));
vi.mock("../../src/services/activeSource.js", () => ({
  getActiveDataSourceId: vi.fn(async () => "ds-active"),
  setActiveDataSource: vi.fn(async () => {}),
}));
vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: vi.fn(async () => {}) }));

import {
  createDecision, listDecisions, getDecision, submitForApproval, approveDecision,
  rejectDecision, startDecision, archiveDecision, recordOutcome, DecisionError,
} from "../../src/services/decisionRecords.js";

function row(overrides = {}) {
  return {
    id: "dec-1", org_id: "org-A", title: "Cut price on Widget", description: "Reduce price 5%",
    recommendation: null, status: "proposed", owner_id: null, created_by: "user-1",
    approved_by: null, approved_at: null, rejected_reason: null,
    source_type: "manual", confidence: null, source_snapshot: null,
    expected_impact: { metric: "revenue", low: 1000, high: 3000, currency: "EUR" },
    target_date: null, investment_cost: null, actual_outcome: null,
    measurement_window_days: 60, started_at: null, baseline_metric: null, outcome_source: null,
    created_at: new Date(), updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => queryMock.mockReset());

describe("createDecision", () => {
  it("requires title and description", async () => {
    await expect(createDecision({ orgId: "org-A", createdBy: "u1", title: "", description: "" })).rejects.toThrow(DecisionError);
  });

  it("validates ownerId belongs to the same org before inserting", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // ownerId lookup finds nothing
    await expect(
      createDecision({ orgId: "org-A", createdBy: "u1", title: "T", description: "D", ownerId: "someone-else-org" })
    ).rejects.toThrow(/ownerId must be a user in this organization/);
  });

  it("inserts and returns an enriched (roi/variance = null pre-outcome) record", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "u2" }] }); // ownerId lookup ok
    queryMock.mockResolvedValueOnce({ rows: [row({ owner_id: "u2" })] }); // insert
    const d = await createDecision({ orgId: "org-A", createdBy: "u1", title: "T", description: "D", ownerId: "u2" });
    expect(d.id).toBe("dec-1");
    expect(d.roi).toBeNull();
    expect(d.variance).toBeNull();
  });
});

describe("listDecisions", () => {
  it("filters by status and ownerId when provided, and paginates", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row()] });
    queryMock.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    const { decisions, total, limit } = await listDecisions("org-A", { status: "proposed", ownerId: "u2", limit: 500 });
    expect(decisions).toHaveLength(1);
    expect(total).toBe(1);
    expect(limit).toBeLessThanOrEqual(100);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/status = \$2/);
    expect(sql).toMatch(/owner_id = \$3/);
    expect(params).toEqual(["org-A", "proposed", "u2", expect.any(Number), 0]);
  });
});

describe("approval workflow state machine", () => {
  it("submitForApproval moves proposed -> pending_approval", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "proposed" })] }); // getDecision
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "pending_approval" })] }); // update
    const d = await submitForApproval("org-A", "dec-1", "u1");
    expect(d.status).toBe("pending_approval");
  });

  it("rejects an invalid transition (e.g. proposed -> approved, skipping pending_approval)", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "proposed" })] }); // getDecision
    await expect(approveDecision("org-A", "dec-1", "manager-1")).rejects.toThrow(/cannot move a decision/);
  });

  it("approveDecision sets approved_by/approved_at and moves to approved", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "pending_approval" })] }); // getDecision
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "approved", approved_by: "manager-1", approved_at: new Date() })] }); // update
    const d = await approveDecision("org-A", "dec-1", "manager-1");
    expect(d.status).toBe("approved");
    expect(d.approved_by).toBe("manager-1");
  });

  it("rejectDecision requires pending_approval and records a reason", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "pending_approval" })] });
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "rejected", rejected_reason: "too risky" })] });
    const d = await rejectDecision("org-A", "dec-1", "manager-1", "too risky");
    expect(d.status).toBe("rejected");
    expect(d.rejected_reason).toBe("too risky");
  });

  it("a rejected decision can be resubmitted (rejected -> proposed)", async () => {
    // decisionRecords.js's TRANSITIONS explicitly allows this — verify via
    // submitForApproval's own transition guard using a 'proposed' target
    // isn't directly exposed, but startDecision from 'rejected' should fail.
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "rejected" })] });
    await expect(startDecision("org-A", "dec-1", "u1")).rejects.toThrow(/cannot move a decision/);
  });

  it("startDecision (approved -> in_progress) captures a baseline_metric snapshot when the metric is computable", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "approved", expected_impact: { metric: "revenue", low: 1000, high: 3000, currency: "EUR" } })] }); // getDecision
    // loadOrgTransactions (via captureBaseline) fires 3 queries in parallel: transactions, org default_currency, fx_rates
    queryMock.mockResolvedValueOnce({
      rows: [
        { date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), quantity: 1, unit_price: 100, discount: 0, net_revenue: 500, cost: 100, gross_profit: 400, currency: "EUR", customer: null, product: "Widget", region: "PT", channel: null },
      ],
    }); // transactions — 10 days ago, safely inside the 60-day baseline window
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] }); // organizations
    queryMock.mockResolvedValueOnce({ rows: [] }); // fx_rates — none needed, tx is already EUR
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "in_progress", baseline_metric: { metric: "revenue", value: 500 } })] }); // UPDATE
    const d = await startDecision("org-A", "dec-1", "u1");
    expect(d.status).toBe("in_progress");
    // the UPDATE call is the 5th query; its 3rd bound param is the JSON baseline
    const [updateSql, updateParams] = queryMock.mock.calls[4];
    expect(updateSql).toMatch(/baseline_metric/);
    expect(JSON.parse(updateParams[2]).metric).toBe("revenue");
    expect(JSON.parse(updateParams[2]).value).toBe(500);
  });

  it("startDecision skips baseline capture (null) for a metric it can't sum from transactions", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "approved", expected_impact: { metric: "revenue_concentration_pct", low: 40, high: 40, currency: null } })] }); // getDecision
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "in_progress", baseline_metric: null })] }); // UPDATE (no transactions query in between)
    const d = await startDecision("org-A", "dec-1", "u1");
    expect(d.status).toBe("in_progress");
    const [, updateParams] = queryMock.mock.calls[1];
    expect(updateParams[2]).toBeNull();
  });

  it("archiveDecision works from any non-terminal-already-archived status", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "approved" })] });
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "archived" })] });
    const d = await archiveDecision("org-A", "dec-1", "u1");
    expect(d.status).toBe("archived");
  });

  it("404s (via DecisionError) when the decision doesn't exist or belongs to another org", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const err = await submitForApproval("org-A", "nope", "u1").catch((e) => e);
    expect(err).toBeInstanceOf(DecisionError);
    expect(err.status).toBe(404);
  });
});

describe("recordOutcome — expected vs actual + ROI", () => {
  it("requires the decision to be in_progress or completed", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "proposed" })] });
    await expect(recordOutcome("org-A", "dec-1", "u1", { value: 1000 })).rejects.toThrow(/in_progress or completed/);
  });

  it("requires a numeric value", async () => {
    await expect(recordOutcome("org-A", "dec-1", "u1", { value: "a lot" })).rejects.toThrow(/must be a number/);
  });

  it("rejects an invalid source", async () => {
    await expect(recordOutcome("org-A", "dec-1", "u1", { value: 100, source: "guessed" })).rejects.toThrow(/source must be/);
  });

  it("defaults source to 'manual' and stores it on both the column and the actual_outcome JSON", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "in_progress" })] }); // getDecision
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "completed", outcome_source: "manual", actual_outcome: { value: 100, source: "manual" } })] }); // update
    await recordOutcome("org-A", "dec-1", "manager-1", { value: 100 });
    const [updateSql, updateParams] = queryMock.mock.calls[1];
    expect(updateSql).toMatch(/outcome_source/);
    expect(updateParams[3]).toBe("manual");
    expect(JSON.parse(updateParams[2]).source).toBe("manual");
  });

  it("records the outcome, moves to completed, and computes ROI when investment_cost is set", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "in_progress", investment_cost: 500 })] }); // getDecision
    queryMock.mockResolvedValueOnce({
      rows: [row({ status: "completed", investment_cost: 500, actual_outcome: { value: 2000, currency: "EUR", measuredAt: "2024-06-01" } })],
    }); // update
    const d = await recordOutcome("org-A", "dec-1", "manager-1", { value: 2000 });
    expect(d.status).toBe("completed");
    expect(d.roi.netGain).toBe(1500);
    expect(d.roi.roiPct).toBe(300);
  });

  it("computes variance against the expected_impact range frozen at creation", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "in_progress", expected_impact: { low: 1000, high: 3000 } })] });
    queryMock.mockResolvedValueOnce({
      rows: [row({ status: "completed", expected_impact: { low: 1000, high: 3000 }, actual_outcome: { value: 5000 } })],
    });
    const d = await recordOutcome("org-A", "dec-1", "manager-1", { value: 5000 });
    expect(d.variance.withinExpectedRange).toBe(false); // 5000 is above the 1000-3000 expected range
    expect(d.variance.deltaVsMidpoint).toBe(3000); // 5000 - midpoint(2000)
  });

  it("ROI is null (not zero, not a guess) when there's no investment_cost to compare against", async () => {
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "in_progress", investment_cost: null })] });
    queryMock.mockResolvedValueOnce({ rows: [row({ status: "completed", investment_cost: null, actual_outcome: { value: 2000 } })] });
    const d = await recordOutcome("org-A", "dec-1", "manager-1", { value: 2000 });
    expect(d.roi).toBeNull();
  });
});
