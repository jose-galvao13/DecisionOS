import dns from "node:dns/promises";
import net from "node:net";

/**
 * SSRF guard for the PostgreSQL connector (roadmap FASE 2: "Bloquear
 * localhost / 127.0.0.1 / redes privadas / metadata endpoints" + "Proteção
 * contra DNS rebinding").
 *
 * The connector accepts a customer-supplied host/port and connects to it
 * server-side — without this, any authenticated admin could point it at
 * 169.254.169.254 (cloud metadata), an internal service, or the backend's
 * own database and have the server fetch it on their behalf.
 *
 * Strategy: resolve the hostname ourselves, reject if ANY resolved address
 * is loopback / private / link-local / metadata / reserved, and hand back
 * that already-validated IP for the caller to connect to directly — never
 * the original hostname. That closes the DNS-rebinding gap: if we instead
 * re-checked the hostname and then let `pg` re-resolve it a moment later,
 * a rebinding attacker could flip the DNS answer between the check and the
 * connection. Handing back a fixed IP means there's nothing left to flip.
 */

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr(ip, cidr) {
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

// Anything here is off-limits for an outbound connector, not just "private
// in the traditional sense" — includes cloud metadata (169.254.169.254 is
// inside 169.254.0.0/16) and the IANA special-purpose ranges used by SSRF
// bypass tricks (0.0.0.0/8, TEST-NETs, benchmarking range, etc).
const BLOCKED_V4_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "255.255.255.255/32",
];

function isBlockedIPv4(ip) {
  return BLOCKED_V4_CIDRS.some((cidr) => inCidr(ip, cidr));
}

// Catches ::ffff:127.0.0.1 and ::ffff:7f00:1 style IPv4-mapped addresses,
// which would otherwise sail past an IPv6-only check.
function extractMappedIPv4(ip) {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (dotted) return dotted[1];
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return [(a >> 8) & 0xff, a & 0xff, (b >> 8) & 0xff, b & 0xff].join(".");
  }
  return null;
}

function isBlockedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  const mapped = extractMappedIPv4(lower);
  if (mapped) return isBlockedIPv4(mapped);
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
  return false;
}

function isBlockedIp(address, family) {
  if (family === 6 || net.isIPv6(address)) return isBlockedIPv6(address);
  if (family === 4 || net.isIPv4(address)) return isBlockedIPv4(address);
  return true; // unrecognized family — fail closed
}

// Escape hatch for local development only (e.g. connecting to a Postgres
// running in Docker on the developer's own machine). Never set this in
// production — doing so re-opens the SSRF hole this file exists to close.
const ALLOW_PRIVATE_HOSTS = process.env.PG_CONNECTOR_ALLOW_PRIVATE_HOSTS === "true";

/**
 * Resolves `host` and returns a single validated IP address safe to
 * connect to. Throws if the host is missing, unresolvable, or resolves to
 * any loopback/private/link-local/metadata/reserved address. Fails closed:
 * DNS errors and unrecognized address families are rejected, not allowed
 * through.
 */
export async function resolveSafeHost(host) {
  if (!host || typeof host !== "string" || !host.trim()) {
    throw new Error("a database host is required");
  }
  const trimmed = host.trim();

  if (ALLOW_PRIVATE_HOSTS) return trimmed;

  let addresses;
  try {
    addresses = await dns.lookup(trimmed, { all: true, verbatim: true });
  } catch {
    throw new Error(`could not resolve host "${trimmed}"`);
  }
  if (!addresses.length) {
    throw new Error(`could not resolve host "${trimmed}"`);
  }

  for (const { address, family } of addresses) {
    if (isBlockedIp(address, family)) {
      throw new Error(
        "connections to localhost, private, link-local, or metadata addresses are not allowed"
      );
    }
  }

  // Pin to the address we just validated — see module comment on why this
  // (rather than re-resolving the hostname at connect time) is what
  // actually stops DNS rebinding.
  return addresses[0].address;
}

/** Basic sanity check — not a security boundary by itself, just avoids
 *  passing garbage into the pg driver. */
export function assertValidPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return n;
}
