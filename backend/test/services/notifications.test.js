import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { signToken } from "../../src/auth/jwt.js";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));
const analyticsMock = vi.fn();
vi.mock("../../src/services/analyticsEngine.js", () => ({ computeAnalyticsForOrg: (...a) => analyticsMock(...a) }));
const findingsMock = vi.fn();
vi.mock("../../src/services/decisionEngine.js", () => ({ generateDecisions: (...a) => findingsMock(...a) }));
const activeMock = vi.fn();
vi.mock("../../src/services/activeSource.js", () => ({ getActiveDataSourceIds: (...a) => activeMock(...a) }));

import { buildNotifications, markRead } from "../../src/services/notifications.js";
import notificationsRouter from "../../src/routes/notifications.routes.js";

// what each query returns; a test overrides only what it cares about
let db;
beforeEach(() => {
  queryMock.mockReset();
  analyticsMock.mockReset();
  findingsMock.mockReset();
  activeMock.mockReset();
  db = { approvals: [], resolved: [], outcomes: [], failedImports: [], quality: [], readKeys: [], throwOn: null };
  activeMock.mockResolvedValue(["ds-1"]);
  analyticsMock.mockResolvedValue({ count: 480, dateRange: { max: new Date("2026-08-31T00:00:00Z") } });
  findingsMock.mockReturnValue([]);
  queryMock.mockImplementation(async (sql) => {
    const kind =
      /status = 'pending_approval'/.test(sql) ? "approvals"
      : /status IN \('approved','rejected'\)/.test(sql) ? "resolved"
      : /actual_outcome IS NOT NULL/.test(sql) ? "outcomes"
      : /FROM jobs j/.test(sql) ? "failedImports"
      : /FROM data_quality_reports/.test(sql) ? "quality"
      : /FROM notification_reads/.test(sql) ? "readKeys"
      : null;
    if (db.throwOn && db.throwOn === kind) throw new Error("boom");
    return { rows: kind ? db[kind] : [] };
  });
});

const asManager = { id: "m1", orgId: "org-A", role: "manager" };
const asViewer = { id: "v1", orgId: "org-A", role: "viewer" };
const kinds = (r) => r.notifications.map((n) => n.kind);
const usedQuery = (re) => queryMock.mock.calls.some(([sql]) => re.test(sql));

describe("buildNotifications — what each role sees", () => {
  it("a manager sees decisions waiting for approval and failed imports", async () => {
    db.approvals = [{ id: "d1", title: "Raise prices", updated_at: "2026-09-20T10:00:00Z", created_by_name: "Ana" }];
    db.failedImports = [{ id: "j1", error: "file is empty", finished_at: "2026-09-20T09:00:00Z", name: "vendas.xlsx" }];
    const r = await buildNotifications(asManager);
    expect(kinds(r)).toEqual(expect.arrayContaining(["approval_pending", "import_failed"]));
    const approval = r.notifications.find((n) => n.kind === "approval_pending");
    expect(approval).toMatchObject({ key: "approval_pending:d1", target: { view: "decisionLog" }, params: { title: "Raise prices", by: "Ana" }, read: false });
  });

  it("a viewer can't act on approvals or imports, so those aren't even queried", async () => {
    const r = await buildNotifications(asViewer);
    expect(usedQuery(/status = 'pending_approval'/)).toBe(false);
    expect(usedQuery(/FROM jobs j/)).toBe(false);
    expect(kinds(r)).toEqual([]);
  });

  it("everyone sees their own decisions being approved or rejected", async () => {
    db.resolved = [
      { id: "d2", title: "Cut costs", status: "approved", rejected_reason: null, updated_at: "2026-09-19T10:00:00Z" },
      { id: "d3", title: "New region", status: "rejected", rejected_reason: "no budget", updated_at: "2026-09-18T10:00:00Z" },
    ];
    const r = await buildNotifications(asViewer);
    expect(r.notifications.map((n) => [n.kind, n.severity])).toEqual([["decision_rejected", "yellow"], ["decision_approved", "green"]]);
    expect(r.notifications[0].params).toEqual({ title: "New region", reason: "no budget" });
    // scoped to this user and this org
    const [, params] = queryMock.mock.calls.find(([sql]) => /status IN \('approved','rejected'\)/.test(sql));
    expect(params.slice(0, 2)).toEqual(["org-A", "v1"]);
  });

  it("outcomes: a manager sees all of them, anyone else only their own", async () => {
    db.outcomes = [{ id: "d4", title: "Loyalty", measured_at: "2026-09-19T00:00:00Z" }];
    await buildNotifications(asManager);
    await buildNotifications(asViewer);
    const seesAll = queryMock.mock.calls.filter(([sql]) => /actual_outcome IS NOT NULL/.test(sql)).map(([, p]) => p[3]);
    expect(seesAll).toEqual([true, false]);
  });
});

describe("buildNotifications — data quality and Decision Engine findings", () => {
  it("only raises data quality below the 'red' line of the Data Quality Center", async () => {
    db.quality = [{ id: "q1", score: "82.0", created_at: "2026-09-20T00:00:00Z", name: "a.xlsx" }];
    expect(kinds(await buildNotifications(asViewer))).not.toContain("low_quality");
    db.quality = [{ id: "q2", score: "54.3", created_at: "2026-09-20T00:00:00Z", name: "a.xlsx" }]; // NUMERIC arrives as a string
    const r = await buildNotifications(asViewer);
    expect(r.notifications.find((n) => n.kind === "low_quality")).toMatchObject({ key: "low_quality:q2", severity: "red", params: { name: "a.xlsx", score: 54 }, target: { view: "dataQuality" } });
  });

  it("skips data quality when there is no active file", async () => {
    activeMock.mockResolvedValue([]);
    expect(usedQuery(/FROM data_quality_reports/)).toBe(false);
    await buildNotifications(asViewer);
    expect(usedQuery(/FROM data_quality_reports/)).toBe(false);
  });

  it("turns only red findings into notifications (at most 3) and keys them to the data they were found in", async () => {
    findingsMock.mockReturnValue([
      { type: "revenue_decline", severity: "red", impact: { low: 12000, currency: "EUR" } },
      { type: "margin_deterioration", severity: "yellow", impact: null },
      { type: "customer_risk", severity: "red", impact: null },
      { type: "cost_leakage", severity: "red", impact: { low: 500, currency: "EUR" } },
      { type: "sales_anomaly", severity: "red", impact: null },
    ]);
    const r = await buildNotifications(asViewer);
    const risks = r.notifications.filter((n) => n.kind === "risk");
    expect(risks).toHaveLength(3);
    expect(risks.map((n) => n.params.type)).toEqual(expect.arrayContaining(["revenue_decline", "customer_risk", "cost_leakage"]));
    expect(risks[0].key).toMatch(/^risk:[a-z_]+:480:2026-08-31$/);
    expect(risks.find((n) => n.params.type === "revenue_decline").params.impact).toEqual({ value: 12000, currency: "EUR" });
    expect(risks.find((n) => n.params.type === "customer_risk").params.impact).toBeNull();
  });

  it("has no findings when there is no data", async () => {
    analyticsMock.mockResolvedValue(null);
    expect(kinds(await buildNotifications(asViewer))).toEqual([]);
  });
});

describe("buildNotifications — read state, ordering and resilience", () => {
  it("marks what this person already read and only counts the rest as unread", async () => {
    db.approvals = [
      { id: "a", title: "A", updated_at: "2026-09-20T10:00:00Z", created_by_name: null },
      { id: "b", title: "B", updated_at: "2026-09-20T11:00:00Z", created_by_name: null },
    ];
    db.readKeys = [{ key: "approval_pending:a" }];
    const r = await buildNotifications(asManager);
    expect(r.notifications.map((n) => [n.key, n.read])).toEqual([["approval_pending:b", false], ["approval_pending:a", true]]); // unread first
    expect(r.unreadCount).toBe(1);
    const [, params] = queryMock.mock.calls.find(([sql]) => /FROM notification_reads/.test(sql));
    expect(params[0]).toBe("m1");
  });

  it("orders unread before read, then red before yellow, then newest first", async () => {
    db.approvals = [{ id: "y", title: "Y", updated_at: "2026-09-20T10:00:00Z", created_by_name: null }]; // yellow
    db.failedImports = [{ id: "r", error: null, finished_at: "2026-09-01T10:00:00Z", name: "x" }]; // red, older
    db.outcomes = [{ id: "o", title: "O", measured_at: "2026-09-21T10:00:00Z" }]; // blue, newest
    const r = await buildNotifications(asManager);
    expect(kinds(r)).toEqual(["import_failed", "approval_pending", "outcome_measured"]);
  });

  it("one source failing doesn't take the whole bell down", async () => {
    db.throwOn = "approvals";
    db.failedImports = [{ id: "j1", error: null, finished_at: "2026-09-20T09:00:00Z", name: "x" }];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await buildNotifications(asManager);
    expect(kinds(r)).toEqual(["import_failed"]);
    errors.mockRestore();
  });
});

describe("markRead", () => {
  it("stores each key once, ignores junk, and caps what one request can write", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const many = Array.from({ length: 150 }, (_, i) => `k${i}`);
    const n = await markRead("u1", ["a", "a", "", 42, null, "x".repeat(201), ...many]);
    expect(n).toBe(100);
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO notification_reads/.test(sql));
    expect(insert[1][0]).toBe("u1");
    expect(insert[1][1]).toHaveLength(100);
    expect(new Set(insert[1][1]).size).toBe(100);
    expect(insert[1][1]).not.toContain("");
  });

  it("does nothing for an empty list", async () => {
    expect(await markRead("u1", [])).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("/api/notifications routes", () => {
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use("/api/notifications", notificationsRouter);
    return a;
  };
  const bearer = `Bearer ${signToken({ sub: "m1", orgId: "org-A", role: "manager", email: "m@a.com" })}`;

  it("needs a token", async () => {
    expect((await request(app()).get("/api/notifications")).status).toBe(401);
    expect((await request(app()).post("/api/notifications/read").send({ all: true })).status).toBe(401);
  });

  it("GET returns the notifications with the unread count", async () => {
    db.approvals = [{ id: "a", title: "A", updated_at: "2026-09-20T10:00:00Z", created_by_name: null }];
    const res = await request(app()).get("/api/notifications").set("Authorization", bearer);
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.notifications[0].key).toBe("approval_pending:a");
  });

  it("POST /read with keys marks those keys for the caller only", async () => {
    const res = await request(app()).post("/api/notifications/read").set("Authorization", bearer).send({ keys: ["approval_pending:a"] });
    expect(res.body).toEqual({ marked: 1 });
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO notification_reads/.test(sql));
    expect(insert[1]).toEqual(["m1", ["approval_pending:a"]]);
  });

  it("POST /read with all:true marks everything currently shown — not arbitrary keys", async () => {
    db.approvals = [{ id: "a", title: "A", updated_at: "2026-09-20T10:00:00Z", created_by_name: null }];
    const res = await request(app()).post("/api/notifications/read").set("Authorization", bearer).send({ all: true, keys: ["ignored"] });
    expect(res.body.marked).toBe(1);
    const insert = queryMock.mock.calls.find(([sql]) => /INSERT INTO notification_reads/.test(sql));
    expect(insert[1][1]).toEqual(["approval_pending:a"]);
  });

  it("400s without keys or all", async () => {
    const res = await request(app()).post("/api/notifications/read").set("Authorization", bearer).send({});
    expect(res.status).toBe(400);
  });
});
