import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { signToken } from "../../src/auth/jwt.js";

vi.mock("../../src/services/decisionRecords.js", async () => {
  const actual = await vi.importActual("../../src/services/decisionRecords.js");
  return {
    ...actual,
    createDecision: vi.fn(async (args) => ({ id: "dec-1", ...args })),
    listDecisions: vi.fn(async () => ({ decisions: [], total: 0, limit: 20, offset: 0 })),
    getDecision: vi.fn(async (orgId, id) => (id === "dec-1" ? { id, org_id: orgId, status: "pending_approval" } : null)),
    submitForApproval: vi.fn(async () => ({ id: "dec-1", status: "pending_approval" })),
    approveDecision: vi.fn(async () => ({ id: "dec-1", status: "approved" })),
    rejectDecision: vi.fn(async () => ({ id: "dec-1", status: "rejected" })),
    startDecision: vi.fn(async () => ({ id: "dec-1", status: "in_progress" })),
    archiveDecision: vi.fn(async () => ({ id: "dec-1", status: "archived" })),
    recordOutcome: vi.fn(async () => ({ id: "dec-1", status: "completed", roi: { netGain: 500, roiPct: 50 } })),
  };
});

vi.mock("../../src/services/decisionActions.js", async () => {
  const actual = await vi.importActual("../../src/services/decisionActions.js");
  return {
    ...actual,
    createAction: vi.fn(async (orgId, decisionId, userId, body) => ({ id: "act-1", decision_id: decisionId, status: "todo", ...body })),
    listActions: vi.fn(async () => [{ id: "act-1", status: "todo" }]),
    updateAction: vi.fn(async (orgId, decisionId, actionId) => ({ id: actionId, status: "done" })),
    deleteAction: vi.fn(async (orgId, decisionId, actionId) => ({ id: actionId })),
  };
});

vi.mock("../../src/services/measurementEngine.js", () => ({
  runDueMeasurements: vi.fn(async () => ({ checked: 2, measured: 1, skipped: 1, failed: 0, errors: [] })),
}));

import decisionRecordsRouter from "../../src/routes/decisionRecords.routes.js";
import * as records from "../../src/services/decisionRecords.js";
import * as actions from "../../src/services/decisionActions.js";
import { runDueMeasurements } from "../../src/services/measurementEngine.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/decision-log", decisionRecordsRouter);
  return app;
}

const managerToken = signToken({ sub: "manager-1", orgId: "org-A", role: "manager", email: "m@a.com" });
const viewerToken = signToken({ sub: "viewer-1", orgId: "org-A", role: "viewer", email: "v@a.com" });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/decision-log", () => {
  it("401s with no token", async () => {
    const res = await request(buildApp()).post("/api/decision-log").send({ title: "T", description: "D" });
    expect(res.status).toBe(401);
  });

  it("a viewer can create (propose) a decision", async () => {
    const res = await request(buildApp()).post("/api/decision-log").set("Authorization", `Bearer ${viewerToken}`)
      .send({ title: "Cut price", description: "Reduce Widget price 5%" });
    expect(res.status).toBe(201);
    expect(records.createDecision).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-A", createdBy: "viewer-1" }));
  });
});

describe("Approval workflow role enforcement", () => {
  it("anyone can submit for approval", async () => {
    const res = await request(buildApp()).post("/api/decision-log/dec-1/submit").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
  });

  it("a viewer CANNOT approve — requires manager or above", async () => {
    const res = await request(buildApp()).post("/api/decision-log/dec-1/approve").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(records.approveDecision).not.toHaveBeenCalled();
  });

  it("a manager CAN approve", async () => {
    const res = await request(buildApp()).post("/api/decision-log/dec-1/approve").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
  });

  it("a viewer CANNOT reject — requires manager or above", async () => {
    const res = await request(buildApp()).post("/api/decision-log/dec-1/reject").set("Authorization", `Bearer ${viewerToken}`).send({ reason: "no" });
    expect(res.status).toBe(403);
  });

  it("a viewer CANNOT record an outcome — requires manager or above (financial accountability gate)", async () => {
    const res = await request(buildApp()).post("/api/decision-log/dec-1/outcome").set("Authorization", `Bearer ${viewerToken}`).send({ value: 2000 });
    expect(res.status).toBe(403);
    expect(records.recordOutcome).not.toHaveBeenCalled();
  });

  it("a manager recording an outcome gets ROI back in the response", async () => {
    const res = await request(buildApp()).post("/api/decision-log/dec-1/outcome").set("Authorization", `Bearer ${managerToken}`).send({ value: 2000 });
    expect(res.status).toBe(200);
    expect(res.body.roi.roiPct).toBe(50);
  });

  it("surfaces a DecisionError's own status/message rather than a generic 500", async () => {
    const { DecisionError } = await vi.importActual("../../src/services/decisionRecords.js");
    records.approveDecision.mockRejectedValueOnce(new DecisionError("cannot move a decision from 'proposed' to 'approved'", 400));
    const res = await request(buildApp()).post("/api/decision-log/dec-1/approve").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot move a decision/);
  });
});

describe("GET /api/decision-log/:id — multi-tenant isolation", () => {
  it("404s for a decision that doesn't exist in this org", async () => {
    const res = await request(buildApp()).get("/api/decision-log/does-not-exist").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(404);
  });
});

describe("Actions (P2 'Decision -> Action')", () => {
  it("any authenticated org member can add an action — no manager gate, unlike approve/reject/outcome", async () => {
    const res = await request(buildApp()).post("/api/decision-log/dec-1/actions").set("Authorization", `Bearer ${viewerToken}`)
      .send({ title: "Enviar email aos clientes", ownerId: "u2" });
    expect(res.status).toBe(201);
    expect(actions.createAction).toHaveBeenCalledWith("org-A", "dec-1", "viewer-1", expect.objectContaining({ title: "Enviar email aos clientes", ownerId: "u2" }));
  });

  it("lists actions for a decision", async () => {
    const res = await request(buildApp()).get("/api/decision-log/dec-1/actions").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("updates an action's status", async () => {
    const res = await request(buildApp()).patch("/api/decision-log/dec-1/actions/act-1").set("Authorization", `Bearer ${viewerToken}`).send({ status: "done" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("done");
  });

  it("deletes an action", async () => {
    const res = await request(buildApp()).delete("/api/decision-log/dec-1/actions/act-1").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(actions.deleteAction).toHaveBeenCalledWith("org-A", "dec-1", "act-1", "viewer-1");
  });
});

describe("POST /api/decision-log/measure-due (P2 'Action -> Measurement' automatizada)", () => {
  it("a viewer CANNOT trigger it — same accountability gate as recording an outcome manually", async () => {
    const res = await request(buildApp()).post("/api/decision-log/measure-due").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(runDueMeasurements).not.toHaveBeenCalled();
  });

  it("a manager can trigger it, scoped to their own org", async () => {
    const res = await request(buildApp()).post("/api/decision-log/measure-due").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checked: 2, measured: 1, skipped: 1, failed: 0, errors: [] });
    expect(runDueMeasurements).toHaveBeenCalledWith("org-A");
  });
});
