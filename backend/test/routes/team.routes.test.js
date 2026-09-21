import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import bcrypt from "bcryptjs";
import { signToken } from "../../src/auth/jwt.js";
import { isTokenRevoked, setSessionState, clearSessionRegistry } from "../../src/auth/sessionRegistry.js";

const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...args) => queryMock(...args) } }));
const writeAuditMock = vi.fn(async () => {});
vi.mock("../../src/audit/auditLog.js", () => ({ writeAudit: (...args) => writeAuditMock(...args) }));

import organizationsRouter from "../../src/routes/organizations.routes.js";

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/api/org", organizationsRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
};
const tok = (id, role) => signToken({ sub: id, orgId: "org-A", role, email: `${id}@a.com` });
const owner = tok("owner-1", "owner");
const admin = tok("admin-1", "admin");
const manager = tok("manager-1", "manager");
const viewer = tok("viewer-1", "viewer");

// the people in org-A that the actions below target
const members = [
  { id: "owner-1", org_id: "org-A", email: "owner-1@a.com", name: "Owner", role: "owner", disabled_at: null },
  { id: "admin-1", org_id: "org-A", email: "admin-1@a.com", name: "Admin", role: "admin", disabled_at: null },
  { id: "admin-2", org_id: "org-A", email: "admin-2@a.com", name: "Admin Two", role: "admin", disabled_at: null },
  { id: "manager-1", org_id: "org-A", email: "manager-1@a.com", name: "Manager", role: "manager", disabled_at: null },
  { id: "viewer-1", org_id: "org-A", email: "viewer-1@a.com", name: "Viewer", role: "viewer", disabled_at: null },
  { id: "viewer-off", org_id: "org-A", email: "off@a.com", name: "Left", role: "viewer", disabled_at: "2026-09-01T00:00:00Z" },
  { id: "viewer-B", org_id: "org-B", email: "b@b.com", name: "Other org", role: "viewer", disabled_at: null },
];
let emailTaken = false;
let insertError = null;

beforeEach(() => {
  queryMock.mockReset();
  writeAuditMock.mockClear();
  clearSessionRegistry();
  emailTaken = false;
  insertError = null;
  queryMock.mockImplementation(async (sql, params) => {
    if (/SELECT 1 FROM users WHERE email/.test(sql)) return { rows: emailTaken ? [{}] : [] };
    if (/INSERT INTO users/.test(sql)) { if (insertError) throw insertError; return { rows: [] }; }
    if (/FROM users WHERE id = \$1 AND org_id = \$2/.test(sql)) {
      const u = members.find((m) => m.id === params[0] && m.org_id === params[1]);
      return { rows: u ? [u] : [] };
    }
    return { rows: [] };
  });
});

const calls = (re) => queryMock.mock.calls.filter(([sql]) => re.test(sql));
const post = (path, token, body) => request(buildApp()).post(path).set("Authorization", `Bearer ${token}`).send(body);
const newMember = { name: "  Ana Silva  ", email: "  Ana.Silva@Acme.PT ", password: "s3guraPass!", role: "viewer" };

describe("POST /api/org/users — add a team member", () => {
  it("creates the person with a trimmed name, lower-cased email and a hashed password", async () => {
    const res = await post("/api/org/users", admin, newMember);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Ana Silva", email: "ana.silva@acme.pt", role: "viewer" });
    const [, params] = calls(/INSERT INTO users/)[0];
    expect(params[1]).toBe("org-A"); // the org comes from the token, never from the body
    expect(params[2]).toBe("ana.silva@acme.pt");
    expect(params[3]).not.toBe("s3guraPass!");
    expect(await bcrypt.compare("s3guraPass!", params[3])).toBe(true);
  });

  it("never lets the body choose the organization", async () => {
    await post("/api/org/users", admin, { ...newMember, orgId: "org-B", org_id: "org-B" });
    expect(calls(/INSERT INTO users/)[0][1][1]).toBe("org-A");
  });

  it("keeps the password out of the audit trail and the response", async () => {
    const res = await post("/api/org/users", admin, newMember);
    expect(JSON.stringify(res.body)).not.toContain("s3guraPass!");
    expect(JSON.stringify(writeAuditMock.mock.calls)).not.toContain("s3guraPass!");
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user.created", after: { email: "ana.silva@acme.pt", name: "Ana Silva", role: "viewer" } }));
  });

  it.each([
    ["a short password", { password: "abc" }, /at least 8/],
    ["a password over bcrypt's 72-byte limit", { password: "x".repeat(73) }, /at most 72/],
    ["an invalid email", { email: "not-an-email" }, /valid address/],
    ["a missing name", { name: "   " }, /required/],
    ["a name that is too long", { name: "x".repeat(101) }, /at most 100/],
    ["an unknown role", { role: "superuser" }, /role must be one of/],
    ["the owner role (there is exactly one owner)", { role: "owner" }, /role must be one of/],
  ])("rejects %s without touching the database", async (_label, override, message) => {
    const res = await post("/api/org/users", admin, { ...newMember, ...override });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(calls(/INSERT INTO users/)).toHaveLength(0);
  });

  it("only an owner can create an admin", async () => {
    expect((await post("/api/org/users", admin, { ...newMember, role: "admin" })).status).toBe(403);
    expect((await post("/api/org/users", owner, { ...newMember, role: "admin" })).status).toBe(201);
  });

  it("is admin-only: managers and viewers are refused", async () => {
    expect((await post("/api/org/users", manager, newMember)).status).toBe(403);
    expect((await post("/api/org/users", viewer, newMember)).status).toBe(403);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("409s on an email that already exists — including when two requests race", async () => {
    emailTaken = true;
    expect((await post("/api/org/users", admin, newMember)).status).toBe(409);
    emailTaken = false;
    insertError = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect((await post("/api/org/users", admin, newMember)).status).toBe(409);
  });
});

describe("GET /api/org/users", () => {
  it("includes whether each person is deactivated", async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: "u1", email: "a@a.com", name: "A", role: "viewer", created_at: "x", disabled_at: null }] });
    const res = await request(buildApp()).get("/api/org/users").set("Authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.users[0]).toHaveProperty("disabled_at");
    expect(queryMock.mock.calls[0][1]).toEqual(["org-A"]);
  });
});

describe("who may manage whom (reset password / deactivate / reactivate)", () => {
  const actions = [
    ["reset-password", { password: "brand-new-pass" }],
    ["deactivate", {}],
    ["reactivate", {}],
  ];

  it.each(actions)("%s: an admin can act on a manager or viewer", async (action, body) => {
    expect((await post("/api/org/users/manager-1/" + action, admin, body)).status).toBe(200);
    expect((await post("/api/org/users/viewer-1/" + action, admin, body)).status).toBe(200);
  });

  it.each(actions)("%s: an admin cannot act on another admin, the owner, or themselves", async (action, body) => {
    for (const target of ["admin-2", "owner-1", "admin-1"]) {
      const res = await post(`/api/org/users/${target}/${action}`, admin, body);
      expect(res.status, `${action} on ${target}`).toBe(403);
    }
  });

  it.each(actions)("%s: an owner can act on an admin, but not on the owner account or themselves", async (action, body) => {
    expect((await post("/api/org/users/admin-2/" + action, owner, body)).status).toBe(200);
    expect((await post("/api/org/users/owner-1/" + action, owner, body)).status).toBe(403);
  });

  it.each(actions)("%s: managers and viewers cannot use it at all", async (action, body) => {
    expect((await post("/api/org/users/viewer-1/" + action, manager, body)).status).toBe(403);
    expect((await post("/api/org/users/viewer-1/" + action, viewer, body)).status).toBe(403);
  });

  it.each(actions)("%s: a person from another organization is a 404, and nothing is changed", async (action, body) => {
    const res = await post("/api/org/users/viewer-B/" + action, admin, body);
    expect(res.status).toBe(404);
    expect(calls(/UPDATE users/)).toHaveLength(0);
  });
});

describe("POST /api/org/users/:id/reset-password", () => {
  it("stores a hash of the new password, ends the person's sessions and audits it without the password", async () => {
    const res = await post("/api/org/users/viewer-1/reset-password", admin, { password: "brand-new-pass" });
    expect(res.status).toBe(200);
    const [, params] = calls(/SET password_hash/)[0];
    expect(await bcrypt.compare("brand-new-pass", params[1])).toBe(true);
    expect(isTokenRevoked({ sub: "viewer-1", iat: 1 })).toBe(true); // a token issued long ago no longer works
    expect(isTokenRevoked({ sub: "viewer-1", iat: Math.floor(Date.now() / 1000) + 1 })).toBe(false); // a fresh sign-in does
    expect(JSON.stringify(writeAuditMock.mock.calls)).not.toContain("brand-new-pass");
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user.password_reset", objectId: "viewer-1" }));
  });

  it("applies the same password rules", async () => {
    const res = await post("/api/org/users/viewer-1/reset-password", admin, { password: "short" });
    expect(res.status).toBe(400);
    expect(calls(/SET password_hash/)).toHaveLength(0);
  });
});

describe("deactivate / reactivate", () => {
  it("deactivating switches the account off and immediately invalidates every token they hold", async () => {
    const res = await post("/api/org/users/manager-1/deactivate", admin, {});
    expect(res.body).toEqual({ id: "manager-1", disabled: true });
    expect(calls(/SET disabled_at/)[0][1]).toEqual(["manager-1", true]);
    // any token, even one minted a moment ago
    expect(isTokenRevoked({ sub: "manager-1", iat: Math.floor(Date.now() / 1000) + 60 })).toBe(true);
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user.deactivated", objectId: "manager-1" }));
  });

  it("does nothing (and audits nothing) for someone already deactivated", async () => {
    await post("/api/org/users/viewer-off/deactivate", admin, {});
    expect(calls(/SET disabled_at/)).toHaveLength(0);
    expect(writeAuditMock).not.toHaveBeenCalled();
  });

  it("reactivating lets them sign in again, but the tokens from before they left stay dead", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // what the registry holds for someone deactivated 10s ago (as loaded from the database at startup)
    setSessionState("viewer-off", { disabled: true, validAfter: nowSec - 10 });
    expect(isTokenRevoked({ sub: "viewer-off", iat: nowSec })).toBe(true);

    await post("/api/org/users/viewer-off/reactivate", admin, {});
    expect(calls(/SET disabled_at/).at(-1)[1]).toEqual(["viewer-off", false]);
    expect(isTokenRevoked({ sub: "viewer-off", iat: nowSec })).toBe(false); // a new sign-in works
    expect(isTokenRevoked({ sub: "viewer-off", iat: nowSec - 60 })).toBe(true); // the old token doesn't come back to life
    expect(writeAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "user.reactivated", objectId: "viewer-off" }));
  });
});

describe("PATCH /api/org/users/:id/role", () => {
  const patch = (token, id, role) => request(buildApp()).patch(`/api/org/users/${id}/role`).set("Authorization", `Bearer ${token}`).send({ role });

  it("changing someone's role makes them sign in again (the role lives in their token)", async () => {
    queryMock.mockImplementation(async (sql) => (/SELECT \* FROM users/.test(sql) ? { rows: [members[3]] } : { rows: [] }));
    const res = await patch(owner, "manager-1", "finance");
    expect(res.status).toBe(200);
    expect(isTokenRevoked({ sub: "manager-1", iat: 1 })).toBe(true);
  });

  it("an owner cannot change their own role (that could leave the organization without one)", async () => {
    const res = await patch(owner, "owner-1", "viewer");
    expect(res.status).toBe(400);
    expect(calls(/UPDATE users SET role/)).toHaveLength(0);
  });

  it("is owner-only", async () => {
    expect((await patch(admin, "viewer-1", "manager")).status).toBe(403);
  });
});
