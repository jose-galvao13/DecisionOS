import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken, verifyToken } from "../../src/auth/jwt.js";
import { hashPassword } from "../../src/auth/password.js";
import { isTokenRevoked, clearSessionRegistry } from "../../src/auth/sessionRegistry.js";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args), connect: vi.fn() } }));
const writeAuditMock = vi.fn(async () => {});
vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: (...args) => writeAuditMock(...args) }));

import authRouter from "../../src/routes/auth.routes.js";

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
};

let hash;
let userRow;
beforeEach(async () => {
  hash = hash || (await hashPassword("old-password-1"));
  clearSessionRegistry();
  queryMock.mockReset();
  writeAuditMock.mockClear();
  userRow = { id: "u1", org_id: "org-A", org_name: "Acme", email: "ana@acme.pt", name: "Ana", role: "manager", password_hash: hash, disabled_at: null };
  queryMock.mockImplementation(async (sql) => (/FROM users u JOIN organizations/.test(sql) ? { rows: [userRow] } : { rows: [] }));
});

const token = () => signToken({ sub: "u1", orgId: "org-A", role: "manager", email: "ana@acme.pt" });
const login = (password) => request(buildApp()).post("/api/auth/login").send({ email: "ana@acme.pt", password });

describe("login and /me for a deactivated account", () => {
  it("signs a normal account in", async () => {
    const res = await login("old-password-1");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("refuses a deactivated account with a clear message — but only after the password was right", async () => {
    userRow.disabled_at = "2026-09-01T00:00:00Z";
    const ok = await login("old-password-1");
    expect(ok.status).toBe(403);
    expect(ok.body.error).toMatch(/deactivated/);
    expect(ok.body.token).toBeUndefined();

    const wrong = await login("not-the-password");
    expect(wrong.status).toBe(401); // doesn't reveal that the account exists
  });

  it("/me says 401 for a deactivated account, so the app drops back to the login screen", async () => {
    userRow.disabled_at = "2026-09-01T00:00:00Z";
    const res = await request(buildApp()).get("/api/auth/me").set("Authorization", `Bearer ${token()}`);
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/change-password", () => {
  const change = (body, t = token()) => request(buildApp()).post("/api/auth/change-password").set("Authorization", `Bearer ${t}`).send(body);

  it("needs a token", async () => {
    const res = await request(buildApp()).post("/api/auth/change-password").send({ currentPassword: "a", newPassword: "b" });
    expect(res.status).toBe(401);
  });

  it("changes the password, cuts the other sessions and hands back a fresh token", async () => {
    const res = await change({ currentPassword: "old-password-1", newPassword: "new-password-22" });
    expect(res.status).toBe(200);
    const update = queryMock.mock.calls.find(([sql]) => /SET password_hash/.test(sql));
    expect(await bcrypt.compare("new-password-22", update[1][1])).toBe(true);
    // an old session (issued earlier) is dead; the token in the response is not
    expect(isTokenRevoked({ sub: "u1", iat: 1 })).toBe(true);
    expect(isTokenRevoked(verifyToken(res.body.token))).toBe(false);
    expect(JSON.stringify(writeAuditMock.mock.calls)).not.toContain("new-password-22");
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user.password_changed", userId: "u1" }));
  });

  it("refuses a wrong current password without changing anything", async () => {
    const res = await change({ currentPassword: "guess", newPassword: "new-password-22" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/current password is incorrect/);
    expect(queryMock.mock.calls.some(([sql]) => /SET password_hash/.test(sql))).toBe(false);
  });

  it("applies the password rules and refuses reusing the same password", async () => {
    expect((await change({ currentPassword: "old-password-1", newPassword: "short" })).status).toBe(400);
    expect((await change({ currentPassword: "old-password-1", newPassword: "old-password-1" })).status).toBe(400);
    expect((await change({ newPassword: "new-password-22" })).status).toBe(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
