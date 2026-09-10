import { verifyToken } from "./jwt.js";

// Owner sees everything; each step down is a strict subset, matching the
// roadmap: CEO(owner)/Admin -> full; Finance -> financial data + simulator +
// DCF; Manager -> BI + customers + products; Viewer -> read-only. Route
// handlers still filter *what* is financial vs BI-only where that matters —
// this hierarchy only gives the ordering.
export const ROLE_RANK = { viewer: 0, manager: 1, finance: 2, admin: 3, owner: 4 };

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "missing bearer token" });
  try {
    const payload = verifyToken(token);
    // req.user.orgId is the ONLY source of tenant scoping for every route
    // that follows — never trust an orgId passed in a request body.
    req.user = { id: payload.sub, orgId: payload.orgId, role: payload.role, email: payload.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: "invalid or expired token" });
  }
}

export function requireMinRole(minRole) {
  const minRank = ROLE_RANK[minRole];
  if (minRank == null) throw new Error(`unknown role in requireMinRole: ${minRole}`);
  return (req, res, next) => {
    const rank = ROLE_RANK[req.user?.role];
    if (rank == null || rank < minRank) {
      return res.status(403).json({ error: `requires role '${minRole}' or higher` });
    }
    next();
  };
}
