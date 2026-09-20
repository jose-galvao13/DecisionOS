import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { signToken } from "../../src/auth/jwt.js";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({
  pool: { query: (...args) => queryMock(...args) },
}));

const stagingStore = new Map();
vi.mock("../../src/services/staging.js", () => ({
  putStaging: vi.fn(({ orgId, headers, rows }) => {
    const id = "staging-1";
    stagingStore.set(id, { orgId, headers, rows });
    return id;
  }),
  getStaging: vi.fn((id, orgId) => {
    const s = stagingStore.get(id);
    return s && s.orgId === orgId ? s : null;
  }),
}));

const enqueueJobMock = vi.fn();
vi.mock("../../src/services/jobQueue.js", () => ({
  enqueueJob: (...args) => enqueueJobMock(...args),
  getJob: vi.fn(async (id, orgId) => (id === "job-owned" && orgId === "org-A" ? { id, org_id: orgId, status: "queued", stage: "queued", progress: 0 } : null)),
  listJobsForSource: vi.fn(async () => ({ jobs: [], total: 0, limit: 20, offset: 0 })),
}));

vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: vi.fn(async () => {}) }));

import datasourcesRouter from "../../src/routes/datasources.routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/datasources", datasourcesRouter);
  // minimal error handler so a thrown error becomes a 500 instead of hanging the test
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  return app;
}

const tokenA = signToken({ sub: "user-A", orgId: "org-A", role: "manager", email: "a@a.com" });
const tokenAdminA = signToken({ sub: "admin-A", orgId: "org-A", role: "admin", email: "admin@a.com" });
const tokenB = signToken({ sub: "user-B", orgId: "org-B", role: "manager", email: "b@b.com" });

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] }); // sane default so unrelated cleanup queries in a test don't crash the route
  enqueueJobMock.mockReset();
  stagingStore.clear();
});

describe("GET /api/datasources — auth required", () => {
  it("401s with no token", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/datasources");
    expect(res.status).toBe(401);
  });

  it("scopes the query to the caller's org and applies pagination bounds", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: "0" }] });
    const app = buildApp();
    const res = await request(app).get("/api/datasources?limit=9999&offset=-1").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE org_id = \$1/);
    expect(params[0]).toBe("org-A");
    expect(params[1]).toBeLessThanOrEqual(100); // clamped limit
  });
});

describe("GET /api/datasources/jobs/:jobId — multi-tenant isolation", () => {
  it("returns the job when it belongs to the caller's org", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/datasources/jobs/job-owned").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.jobId).toBe("job-owned");
  });

  it("404s when the job belongs to a different org — org B can't peek at org A's job by guessing the id", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/datasources/jobs/job-owned").set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /api/datasources/excel/commit — async import + dataset limits", () => {
  it("requires stagingId and mapping", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/datasources/excel/commit").set("Authorization", `Bearer ${tokenA}`).send({});
    expect(res.status).toBe(400);
  });

  it("rejects a mapping missing required fields", async () => {
    stagingStore.set("staging-x", { orgId: "org-A", rows: [{ a: 1 }] });
    const app = buildApp();
    const res = await request(app).post("/api/datasources/excel/commit").set("Authorization", `Bearer ${tokenA}`)
      .send({ stagingId: "staging-x", mapping: { date: "d" } }); // missing revenue
    expect(res.status).toBe(400);
  });

  it("410s when the staging entry is missing or belongs to another org", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/datasources/excel/commit").set("Authorization", `Bearer ${tokenA}`)
      .send({ stagingId: "does-not-exist", mapping: { date: "d", revenue: "r" } });
    expect(res.status).toBe(410);
  });

  it("413s when the staged dataset is over the row limit — a clear limit, not silent truncation", async () => {
    stagingStore.set("staging-big", { orgId: "org-A", rows: new Array(200_001).fill({ d: "01/01/2024", r: "10" }) });
    const app = buildApp();
    const res = await request(app).post("/api/datasources/excel/commit").set("Authorization", `Bearer ${tokenA}`)
      .send({ stagingId: "staging-big", mapping: { date: "d", revenue: "r" } });
    expect(res.status).toBe(413);
    expect(res.body.limit).toBe(200_000);
  });

  it("returns 202 + a jobId immediately instead of blocking on the import (FASE 8 async flow)", async () => {
    stagingStore.set("staging-ok", { orgId: "org-A", rows: [{ d: "01/01/2024", r: "10" }] });
    queryMock.mockResolvedValueOnce({ rows: [] }); // INSERT INTO data_sources
    enqueueJobMock.mockResolvedValueOnce({ id: "job-new", status: "queued", stage: "queued", progress: 0 });
    const app = buildApp();
    const res = await request(app).post("/api/datasources/excel/commit").set("Authorization", `Bearer ${tokenA}`)
      .send({ stagingId: "staging-ok", mapping: { date: "d", revenue: "r" }, name: "test.xlsx" });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe("job-new");
    expect(res.body.status).toBe("queued");
    // enqueued for the authenticated user's own org, never a client-supplied one
    expect(enqueueJobMock).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-A", type: "import_excel" }));
  });
});

describe("POST /api/datasources/postgres/commit — connector security (SSRF) + role requirement", () => {
  it("requires admin role, not just manager", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/datasources/postgres/commit").set("Authorization", `Bearer ${tokenA}`) // manager
      .send({ config: { host: "example.com", database: "d", user: "u", password: "p" }, schema: "public", table: "t", mapping: { date: "d", revenue: "r" } });
    expect(res.status).toBe(403);
  });

  it("rejects a loopback/private host before ever persisting the data source", async () => {
    const app = buildApp();
    const res = await request(app).post("/api/datasources/postgres/commit").set("Authorization", `Bearer ${tokenAdminA}`)
      .send({ config: { host: "127.0.0.1", database: "d", user: "u", password: "p" }, schema: "public", table: "t", mapping: { date: "d", revenue: "r" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not allowed/i);
    // never reaches the INSERT
    expect(queryMock).not.toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO data_sources/), expect.anything());
  });
});

describe("GET /api/datasources/:id/quality", () => {
  it("sends the score as a number — Postgres NUMERIC arrives as a string, which made the UI show NaN%", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ score: "100.0", issues: [{ code: "valid_revenue_pct", severity: "green", count: 10 }], stats: { rows: 10, duplicates: 0 }, created_at: "2026-09-20T17:42:23Z" }],
    });
    const res = await request(buildApp()).get("/api/datasources/ds-1/quality").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.score).toBe(100);
    expect(typeof res.body.score).toBe("number");
    expect(res.body.stats).toEqual({ rows: 10, duplicates: 0 });
  });

  it("404s when the source has no report yet", async () => {
    const res = await request(buildApp()).get("/api/datasources/ds-1/quality").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });
});
