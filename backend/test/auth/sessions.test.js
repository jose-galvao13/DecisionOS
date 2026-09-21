import { describe, it, expect, vi, beforeEach } from "vitest";
import { signToken } from "../../src/auth/jwt.js";
import { requireAuth } from "../../src/auth/middleware.js";
import { isTokenRevoked, setSessionState, clearSessionRegistry } from "../../src/auth/sessionRegistry.js";
import { passwordProblem } from "../../src/auth/passwordPolicy.js";

const run = (token) => {
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  const next = vi.fn();
  requireAuth(req, res, next);
  return { req, res, next };
};
const now = () => Math.floor(Date.now() / 1000);

beforeEach(() => clearSessionRegistry());

describe("requireAuth — revoked sessions", () => {
  const token = signToken({ sub: "u1", orgId: "org-A", role: "viewer", email: "u@a.com" });

  it("lets a normal token through", () => {
    const { next } = run(token);
    expect(next).toHaveBeenCalled();
  });

  it("rejects every token of a deactivated person, immediately", () => {
    setSessionState("u1", { disabled: true });
    const { res, next } = run(token);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a token issued before the person's sessions were cut, but not one issued after", () => {
    setSessionState("u1", { validAfter: now() + 100 });
    expect(run(token).res.status).toHaveBeenCalledWith(401);
    setSessionState("u1", { validAfter: now() });
    expect(run(token).next).toHaveBeenCalled(); // same second still counts as new: a fresh sign-in must work
  });

  it("only affects the person it was set for", () => {
    setSessionState("someone-else", { disabled: true });
    expect(run(token).next).toHaveBeenCalled();
  });
});

describe("isTokenRevoked", () => {
  it("treats a missing iat as old", () => {
    setSessionState("u1", { validAfter: now() });
    expect(isTokenRevoked({ sub: "u1" })).toBe(true);
  });
});

describe("passwordProblem", () => {
  it("accepts 8+ characters and rejects the rest", () => {
    expect(passwordProblem("12345678")).toBeNull();
    expect(passwordProblem("1234567")).toMatch(/at least 8/);
    expect(passwordProblem(undefined)).toMatch(/at least 8/);
    expect(passwordProblem(12345678)).toMatch(/at least 8/);
  });
  it("rejects what bcrypt would silently truncate", () => {
    expect(passwordProblem("a".repeat(72))).toBeNull();
    expect(passwordProblem("a".repeat(73))).toMatch(/at most 72/);
    expect(passwordProblem("é".repeat(37))).toMatch(/at most 72/); // 74 bytes
  });
});
