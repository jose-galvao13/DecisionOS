import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCached, setCached, invalidate, invalidateByPrefix, clearAll } from "../../src/services/cache.js";

describe("cache", () => {
  beforeEach(() => clearAll());

  it("returns undefined for a missing key", () => {
    expect(getCached("nope")).toBeUndefined();
  });

  it("stores and retrieves a value", () => {
    setCached("k1", { a: 1 }, 10_000);
    expect(getCached("k1")).toEqual({ a: 1 });
  });

  it("expires entries after their TTL", () => {
    vi.useFakeTimers();
    setCached("k2", "v", 100);
    vi.advanceTimersByTime(150);
    expect(getCached("k2")).toBeUndefined();
    vi.useRealTimers();
  });

  it("invalidate() removes a single key", () => {
    setCached("k3", "v");
    invalidate("k3");
    expect(getCached("k3")).toBeUndefined();
  });

  it("invalidateByPrefix() removes only matching keys — used to drop all cached analytics for one org", () => {
    setCached("analytics:org1:a", 1);
    setCached("analytics:org1:b", 2);
    setCached("analytics:org2:a", 3);
    invalidateByPrefix("analytics:org1:");
    expect(getCached("analytics:org1:a")).toBeUndefined();
    expect(getCached("analytics:org1:b")).toBeUndefined();
    expect(getCached("analytics:org2:a")).toBe(3); // other org untouched
  });
});
