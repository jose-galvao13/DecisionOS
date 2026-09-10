import { describe, it, expect, vi, beforeEach } from "vitest";

// resolveSafeHost calls dns.lookup — mock it so this test doesn't depend on
// real network/DNS resolution and can deterministically exercise every
// blocked range without needing an actual server listening there.
vi.mock("node:dns/promises", () => ({
  default: { lookup: vi.fn() },
}));

import dns from "node:dns/promises";
import { resolveSafeHost, assertValidPort } from "../../src/utils/ssrfGuard.js";

function mockResolves(address, family = 4) {
  dns.lookup.mockResolvedValue([{ address, family }]);
}

describe("resolveSafeHost — connector security (SSRF guard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects loopback (127.0.0.1)", async () => {
    mockResolves("127.0.0.1");
    await expect(resolveSafeHost("localhost")).rejects.toThrow(/not allowed/i);
  });

  it("rejects private RFC1918 ranges", async () => {
    mockResolves("10.0.0.5");
    await expect(resolveSafeHost("internal.corp")).rejects.toThrow(/not allowed/i);
  });

  it("rejects cloud metadata address 169.254.169.254", async () => {
    mockResolves("169.254.169.254");
    await expect(resolveSafeHost("metadata.google.internal")).rejects.toThrow(/not allowed/i);
  });

  it("rejects IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", async () => {
    mockResolves("::ffff:127.0.0.1", 6);
    await expect(resolveSafeHost("sneaky")).rejects.toThrow(/not allowed/i);
  });

  it("rejects IPv6 loopback (::1)", async () => {
    mockResolves("::1", 6);
    await expect(resolveSafeHost("sneaky6")).rejects.toThrow(/not allowed/i);
  });

  it("rejects IPv6 unique-local (fc00::/7)", async () => {
    mockResolves("fd12:3456:789a::1", 6);
    await expect(resolveSafeHost("ula")).rejects.toThrow(/not allowed/i);
  });

  it("allows a public IP and pins to the resolved address", async () => {
    mockResolves("93.184.216.34");
    await expect(resolveSafeHost("example.com")).resolves.toBe("93.184.216.34");
  });

  it("rejects an empty host", async () => {
    await expect(resolveSafeHost("")).rejects.toThrow(/host is required/i);
  });

  it("fails closed when DNS resolution errors out", async () => {
    dns.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(resolveSafeHost("does-not-exist.invalid")).rejects.toThrow(/could not resolve/i);
  });
});

describe("assertValidPort", () => {
  it("accepts a normal port", () => {
    expect(assertValidPort(5432)).toBe(5432);
  });
  it("rejects out-of-range / non-integer ports", () => {
    expect(() => assertValidPort(0)).toThrow();
    expect(() => assertValidPort(70000)).toThrow();
    expect(() => assertValidPort("abc")).toThrow();
    expect(() => assertValidPort(5432.5)).toThrow();
  });
});
