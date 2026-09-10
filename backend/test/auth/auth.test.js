import { describe, it, expect, vi } from "vitest";
import { signToken, verifyToken } from "../../src/auth/jwt.js";
import { requireAuth, requireMinRole, ROLE_RANK } from "../../src/auth/middleware.js";

function mockRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

describe("jwt sign/verify", () => {
  it("round-trips a payload", () => {
    const token = signToken({ sub: "user-1", orgId: "org-1", role: "manager", email: "a@b.com" });
    const decoded = verifyToken(token);
    expect(decoded.sub).toBe("user-1");
    expect(decoded.orgId).toBe("org-1");
    expect(decoded.role).toBe("manager");
  });

  it("rejects a tampered token", () => {
    const token = signToken({ sub: "user-1", orgId: "org-1", role: "viewer" });
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => verifyToken(tampered)).toThrow();
  });

  it("rejects a token signed with a different secret", async () => {
    // simulate a forged/foreign token, bypassing our jwt.js wrapper entirely
    const jwt = (await import("jsonwebtoken")).default;
    const forged = jwt.sign({ sub: "attacker", orgId: "victim-org", role: "owner" }, "wrong-secret");
    expect(() => verifyToken(forged)).toThrow();
  });
});

describe("requireAuth — multi-tenant scoping", () => {
  it("rejects requests with no bearer token", () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an invalid token", () => {
    const req = { headers: { authorization: "Bearer garbage" } };
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("attaches req.user.orgId from the token — never from anything client-supplied", () => {
    const token = signToken({ sub: "user-1", orgId: "org-A", role: "admin", email: "a@b.com" });
    const req = { headers: { authorization: `Bearer ${token}` }, body: { orgId: "org-B" } }; // attempted spoof in body
    const res = mockRes();
    const next = vi.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.user.orgId).toBe("org-A"); // body's org-B is never used
  });
});

describe("requireMinRole — role hierarchy", () => {
  it("ranks roles as viewer < manager < finance < admin < owner", () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.manager);
    expect(ROLE_RANK.manager).toBeLessThan(ROLE_RANK.finance);
    expect(ROLE_RANK.finance).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.owner);
  });

  it("allows a role at or above the minimum", () => {
    const req = { user: { role: "admin" } };
    const res = mockRes();
    const next = vi.fn();
    requireMinRole("manager")(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it("blocks a role below the minimum with 403", () => {
    const req = { user: { role: "viewer" } };
    const res = mockRes();
    const next = vi.fn();
    requireMinRole("admin")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("blocks when req.user is missing entirely (auth ran but didn't set a role)", () => {
    const req = {};
    const res = mockRes();
    const next = vi.fn();
    requireMinRole("viewer")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
