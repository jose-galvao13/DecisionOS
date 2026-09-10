import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { signToken } from "../../src/auth/jwt.js";

// Mock computeAnalyticsForOrg directly rather than the DB pool — these
// routes are thin wrappers around analyticsEngine + decisionEngine /
// simulationEngine, both already covered by their own unit tests.
const computeAnalyticsForOrgMock = vi.fn();
vi.mock("../../src/services/analyticsEngine.js", () => ({
  computeAnalyticsForOrg: (...args) => computeAnalyticsForOrgMock(...args),
}));

import decisionsRouter from "../../src/routes/decisions.routes.js";
import simulationRouter from "../../src/routes/simulation.routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/decisions", decisionsRouter);
  app.use("/api/simulate", simulationRouter);
  return app;
}

const token = signToken({ sub: "user-A", orgId: "org-A", role: "manager", email: "a@a.com" });

function fakeAnalytics() {
  return {
    count: 500,
    monthly: Array.from({ length: 6 }, (_, i) => ({ key: `2024-0${i + 1}`, revenue: 10000 - i * 2000, profit: 4000 - i * 1000 })),
    totals: { revenue: 40000, profit: 15000, margin: 37.5 },
    deltas: { revenue: -20, profit: -20, marginPP: 0 },
    dateRange: { min: new Date("2024-01-01"), max: new Date("2024-06-30") },
    productIntelligence: [],
    regionGrowth: [],
    byProduct: [], byRegion: [], byChannel: [],
    customerIntelligence: { segments: { churned: [], atRisk: [], loyal: [], new: [] } },
    priceElasticity: null,
    leakage: 0, churnRate: 0,
  };
}

beforeEach(() => computeAnalyticsForOrgMock.mockReset());

describe("GET /api/decisions — P0 fix: real Decision Engine reaches the product surface", () => {
  it("401s with no token", async () => {
    const res = await request(buildApp()).get("/api/decisions");
    expect(res.status).toBe(401);
  });

  it("returns decisions with confidence/evidence, plus a dataCoverage summary", async () => {
    computeAnalyticsForOrgMock.mockResolvedValueOnce(fakeAnalytics());
    const res = await request(buildApp()).get("/api/decisions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.dataCoverage).toEqual({ transactions: 500, monthsCovered: 6, dateRange: { from: "2024-01-01", to: "2024-06-30" } });
    // A -20% revenue decline over 6 months should clear the materiality bar.
    const decline = res.body.decisions.find((d) => d.type === "revenue_decline");
    expect(decline).toBeTruthy();
    expect(typeof decline.confidence).toBe("number");
    expect(decline.evidence.transactions).toBe(500);
  });

  it("returns an empty (not error) response when there's no data yet", async () => {
    computeAnalyticsForOrgMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/api/decisions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.decisions).toEqual([]);
    expect(res.body.dataCoverage.transactions).toBe(0);
  });
});

describe("POST /api/simulate type=levers — P0 fix: replaces the frontend's fabricated 90% CI", () => {
  it("returns a real evidence-based range, never claiming a specific confidence level", async () => {
    computeAnalyticsForOrgMock.mockResolvedValueOnce(fakeAnalytics());
    const res = await request(buildApp()).post("/api/simulate").set("Authorization", `Bearer ${token}`)
      .send({ type: "levers", pricePct: 5, marketingPct: 10, churnPct: 2 });
    expect(res.status).toBe(200);
    expect(res.body.impact.estimatedRange).toHaveProperty("low");
    expect(res.body.impact.estimatedRange).toHaveProperty("high");
    expect(res.body.rangeMethodology).toMatch(/not a formal statistical confidence interval/i);
    expect(res.body.assumptions.levers).toHaveLength(3);
    for (const lever of res.body.assumptions.levers) {
      expect(["estimated", "assumption"]).toContain(lever.source);
    }
  });

  it("404s clearly when there's no data yet rather than simulating against nothing", async () => {
    computeAnalyticsForOrgMock.mockResolvedValueOnce(null);
    const res = await request(buildApp()).post("/api/simulate").set("Authorization", `Bearer ${token}`)
      .send({ type: "levers", pricePct: 5 });
    expect(res.status).toBe(404);
  });
});
