// Mirrors the backend (auth/middleware.js ROLE_RANK + requireMinRole) — the UI
// only decides what to *show*; the server is what actually enforces it.
export const ROLES = ["owner", "admin", "finance", "manager", "viewer"];
export const ASSIGNABLE_ROLES = ["viewer", "manager", "finance", "admin"]; // "owner" is never handed out from the UI
export const canManageTeam = (role) => role === "admin" || role === "owner";

/** Same rule as backend canManageMember: not yourself, never the owner, and
 *  only an owner manages admins. */
export function canManageMember(me, member) {
  if (!me || member.id === me.id) return false;
  if (member.role === "owner") return false;
  if (me.role === "owner") return true;
  return member.role !== "admin";
}

export const initialsOf = (name) => (name || "?").trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";
