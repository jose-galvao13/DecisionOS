import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { signToken } from "../../src/auth/jwt.js";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));

const writeAuditMock = vi.fn(async () => {});
vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: (...args) => writeAuditMock(...args) }));

import organizationsRouter from "../../src/routes/organizations.routes.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/organizations", organizationsRouter);
  return app;
}

const ownerToken = signToken({ sub: "owner-1", orgId: "org-A", role: "owner", email: "o@a.com" });
const adminToken = signToken({ sub: "admin-1", orgId: "org-A", role: "admin", email: "a@a.com" });
const managerToken = signToken({ sub: "manager-1", orgId: "org-A", role: "manager", email: "m@a.com" });
const viewerToken = signToken({ sub: "viewer-1", orgId: "org-A", role: "viewer", email: "v@a.com" });

beforeEach(() => {
  queryMock.mockReset();
  writeAuditMock.mockClear();
});

describe("GET /api/organizations", () => {
  it("401s with no token", async () => {
    const res = await request(buildApp()).get("/api/organizations");
    expect(res.status).toBe(401);
  });

  it("includes default_currency in the response", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "org-A", name: "Acme", default_currency: "USD", created_at: new Date() }] });
    queryMock.mockResolvedValueOnce({ rows: [{ count: "3" }] });
    const res = await request(buildApp()).get("/api/organizations").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.default_currency).toBe("USD");
    expect(res.body.userCount).toBe(3);
  });
});

describe("PATCH /api/organizations", () => {
  it("401s with no token", async () => {
    const res = await request(buildApp()).patch("/api/organizations").send({ defaultCurrency: "USD" });
    expect(res.status).toBe(401);
  });

  it("a viewer cannot change the default currency (requires admin+)", async () => {
    const res = await request(buildApp())
      .patch("/api/organizations")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ defaultCurrency: "USD" });
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("an admin can change the default currency", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: "org-A", name: "Acme", default_currency: "USD", created_at: new Date() }],
    });
    const res = await request(buildApp())
      .patch("/api/organizations")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ defaultCurrency: "usd" }); // lowercase on purpose — should normalize
    expect(res.status).toBe(200);
    expect(res.body.default_currency).toBe("USD");
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("UPDATE organizations"), ["org-A", "USD"]);
    expect(writeAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "organization.default_currency_changed", orgId: "org-A" })
    );
  });

  it("an owner can also change the default currency", async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: "org-A", name: "Acme", default_currency: "GBP", created_at: new Date() }],
    });
    const res = await request(buildApp())
      .patch("/api/organizations")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ defaultCurrency: "GBP" });
    expect(res.status).toBe(200);
  });

  it("rejects an unsupported currency code without touching the database", async () => {
    const res = await request(buildApp())
      .patch("/api/organizations")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ defaultCurrency: "XYZ" });
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("rejects a missing defaultCurrency", async () => {
    const res = await request(buildApp())
      .patch("/api/organizations")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/organizations/fx-rates", () => {
  it("any authenticated org member can list rates", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "r1", currency: "USD", rate_to_default: 0.9 }] });
    const res = await request(buildApp()).get("/api/organizations/fx-rates").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("POST /api/organizations/fx-rates", () => {
  it("a viewer cannot set a rate (requires manager+)", async () => {
    const res = await request(buildApp())
      .post("/api/organizations/fx-rates")
      .set("Authorization", `Bearer ${viewerToken}`)
      .send({ currency: "USD", rateToDefault: 0.9 });
    expect(res.status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("a manager can set a rate", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] }); // fxRates.setRate's org lookup
    queryMock.mockResolvedValueOnce({ rows: [{ id: "r1", org_id: "org-A", currency: "USD", rate_to_default: 0.9, effective_date: "2024-01-01" }] }); // insert
    const res = await request(buildApp())
      .post("/api/organizations/fx-rates")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ currency: "usd", rateToDefault: 0.9, effectiveDate: "2024-01-01" });
    expect(res.status).toBe(201);
    expect(res.body.currency).toBe("USD");
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "fx_rate.set" }));
  });

  it("400s a rate for the org's own default currency, without inserting anything", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ default_currency: "EUR" }] });
    const res = await request(buildApp())
      .post("/api/organizations/fx-rates")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ currency: "EUR", rateToDefault: 1 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/organizations/fx-rates/:id", () => {
  it("a viewer cannot delete a rate", async () => {
    const res = await request(buildApp()).delete("/api/organizations/fx-rates/r1").set("Authorization", `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
  });

  it("a manager can delete a rate", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "r1", currency: "USD" }] });
    const res = await request(buildApp()).delete("/api/organizations/fx-rates/r1").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "fx_rate.deleted" }));
  });

  it("404s deleting a rate that doesn't exist", async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).delete("/api/organizations/fx-rates/nope").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(404);
  });
});
