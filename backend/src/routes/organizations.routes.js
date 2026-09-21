import { Router } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { requireAuth, requireMinRole, ROLE_RANK } from "../auth/middleware.js";
import { passwordProblem } from "../auth/passwordPolicy.js";
import { revokeUserSessions, setUserDisabled } from "../services/userAdmin.js";
import { writeAudit } from "../audit/auditLog.js";
import * as fxRates from "../services/fxRates.js";
import { invalidateOrgAnalyticsCache } from "../services/analyticsEngine.js";

const router = Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, name, default_currency, created_at FROM organizations WHERE id = $1",
    [req.user.orgId]
  );
  if (!rows.length) return res.status(404).json({ error: "organization not found" });
  const { rows: userCountRows } = await pool.query("SELECT COUNT(*) FROM users WHERE org_id = $1", [req.user.orgId]);
  res.json({ ...rows[0], userCount: Number(userCountRows[0].count) });
});

// Deliberately small allow-list rather than "any 3 letters" — this is a
// display/fallback label used across decisionEngine.js and the import
// pipeline (unifiedModel.js), not a validated ISO 4217 lookup, so it's
// worth keeping to currencies this product's copy actually accounts for.
const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "BRL", "JPY", "CAD", "AUD"];

/** Org-level fallback currency: used for any transaction whose source data
 *  doesn't carry its own currency column (see unifiedModel.js). Does not
 *  retroactively change already-imported transactions or convert amounts —
 *  re-import a data source after changing this if it should apply there too. */
router.patch("/", requireMinRole("admin"), async (req, res) => {
  const { defaultCurrency } = req.body || {};
  if (!defaultCurrency || !SUPPORTED_CURRENCIES.includes(String(defaultCurrency).toUpperCase())) {
    return res.status(400).json({ error: `defaultCurrency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}` });
  }
  const currency = String(defaultCurrency).toUpperCase();
  const { rows } = await pool.query(
    "UPDATE organizations SET default_currency = $2 WHERE id = $1 RETURNING id, name, default_currency, created_at",
    [req.user.orgId, currency]
  );
  if (!rows.length) return res.status(404).json({ error: "organization not found" });
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "organization.default_currency_changed",
    objectType: "organization", objectId: req.user.orgId, after: { defaultCurrency: currency },
  });
  res.json(rows[0]);
});

router.get("/users", requireMinRole("admin"), async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, name, role, created_at, disabled_at FROM users WHERE org_id = $1 ORDER BY created_at",
    [req.user.orgId]
  );
  res.json({ users: rows });
});

const INVITABLE_ROLES = ["admin", "finance", "manager", "viewer"];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 100;

/** Admin/owner directly creates a teammate: name + email + an initial password
 *  they hand over themselves. (A real invite-by-email flow with its own accept
 *  link is a small addition on top of this — needs outgoing email first.) The
 *  new person can change the password themselves under "My account". */
router.post("/users", requireMinRole("admin"), async (req, res) => {
  const { password, role } = req.body || {};
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  if (!email || !name || !password || !role) {
    return res.status(400).json({ error: "email, name, password and role are required" });
  }
  if (name.length > MAX_NAME_LENGTH) return res.status(400).json({ error: `name must be at most ${MAX_NAME_LENGTH} characters` });
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) return res.status(400).json({ error: "email is not a valid address" });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (!INVITABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${INVITABLE_ROLES.join(", ")}` });
  }
  // Only an owner can create another admin — an admin can't promote peers.
  if (role === "admin" && req.user.role !== "owner") {
    return res.status(403).json({ error: "only an owner can create an admin" });
  }
  const existing = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
  if (existing.rows.length) return res.status(409).json({ error: "a user with this email already exists" });

  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    await pool.query(
      `INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.user.orgId, email, passwordHash, name, role]
    );
  } catch (e) {
    if (e?.code === "23505") return res.status(409).json({ error: "a user with this email already exists" }); // created in parallel
    throw e;
  }
  await writeAudit({ orgId: req.user.orgId, userId: req.user.id, action: "user.created", objectType: "user", objectId: id, after: { email, name, role } });
  res.status(201).json({ id, email, name, role });
});

/** Who may act on whom. Nobody acts on themselves here (own password ->
 *  /api/auth/change-password; own role/deactivation would risk locking the
 *  organization out), an owner can't be touched, and only an owner manages
 *  admins — so an admin can't strip or take over a peer. */
function canManageMember(actor, target) {
  if (target.id === actor.id) return false;
  if (target.role === "owner") return false;
  if (actor.role === "owner") return true;
  return ROLE_RANK[target.role] < ROLE_RANK.admin;
}

async function loadMemberOr404(req, res) {
  const { rows } = await pool.query("SELECT id, org_id, email, name, role, disabled_at FROM users WHERE id = $1 AND org_id = $2", [req.params.id, req.user.orgId]);
  if (!rows.length) { res.status(404).json({ error: "user not found" }); return null; }
  return rows[0];
}

router.patch("/users/:id/role", requireMinRole("owner"), async (req, res) => {
  const { role } = req.body || {};
  if (!INVITABLE_ROLES.includes(role) && role !== "owner") {
    return res.status(400).json({ error: "invalid role" });
  }
  if (req.params.id === req.user.id) return res.status(400).json({ error: "you can't change your own role" });
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 AND org_id = $2", [req.params.id, req.user.orgId]);
  if (!rows.length) return res.status(404).json({ error: "user not found" });
  const before = rows[0].role;
  await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, req.params.id]);
  // The role is baked into the person's token — make them sign in again to pick up the new one.
  await revokeUserSessions(req.params.id);
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "user.role_changed",
    objectType: "user", objectId: req.params.id, before: { role: before }, after: { role },
  });
  res.json({ id: req.params.id, role });
});

/** Set a new password for a teammate (they forgot it, or the one handed over
 *  at creation was shared too widely). Their current sessions end. */
router.post("/users/:id/reset-password", requireMinRole("admin"), async (req, res) => {
  const problem = passwordProblem(req.body?.password);
  if (problem) return res.status(400).json({ error: problem });
  const member = await loadMemberOr404(req, res);
  if (!member) return;
  if (!canManageMember(req.user, member)) return res.status(403).json({ error: "you can't manage this user" });
  await pool.query("UPDATE users SET password_hash = $2 WHERE id = $1", [member.id, await hashPassword(req.body.password)]);
  await revokeUserSessions(member.id);
  // never put the password (or its hash) in the audit trail
  await writeAudit({ orgId: req.user.orgId, userId: req.user.id, action: "user.password_reset", objectType: "user", objectId: member.id, after: { email: member.email } });
  res.json({ id: member.id, reset: true });
});

/** Someone leaves the company: switch the account off. Their history (decisions
 *  they owned, files they uploaded) stays attributed to them, they simply can't
 *  sign in any more and any session they have open ends immediately. */
router.post("/users/:id/deactivate", requireMinRole("admin"), async (req, res) => {
  const member = await loadMemberOr404(req, res);
  if (!member) return;
  if (!canManageMember(req.user, member)) return res.status(403).json({ error: "you can't manage this user" });
  if (!member.disabled_at) {
    await setUserDisabled(member.id, true);
    await writeAudit({ orgId: req.user.orgId, userId: req.user.id, action: "user.deactivated", objectType: "user", objectId: member.id, after: { email: member.email } });
  }
  res.json({ id: member.id, disabled: true });
});

router.post("/users/:id/reactivate", requireMinRole("admin"), async (req, res) => {
  const member = await loadMemberOr404(req, res);
  if (!member) return;
  if (!canManageMember(req.user, member)) return res.status(403).json({ error: "you can't manage this user" });
  if (member.disabled_at) {
    await setUserDisabled(member.id, false);
    await writeAudit({ orgId: req.user.orgId, userId: req.user.id, action: "user.reactivated", objectType: "user", objectId: member.id, after: { email: member.email } });
  }
  res.json({ id: member.id, disabled: false });
});

/* --------------------------- FX rates (P2) ---------------------------- */
// Real currency conversion (fxRates.js), not just a display label like
// default_currency above. manager+ because this changes what every
// analytics total across the org actually shows, same accountability
// bar as approving a decision.

router.get("/fx-rates", async (req, res) => {
  res.json(await fxRates.listRates(req.user.orgId));
});

router.post("/fx-rates", requireMinRole("manager"), async (req, res) => {
  try {
    const rate = await fxRates.setRate(req.user.orgId, req.user.id, {
      currency: req.body?.currency, rateToDefault: req.body?.rateToDefault, effectiveDate: req.body?.effectiveDate,
    });
    invalidateOrgAnalyticsCache(req.user.orgId); // every totals view depends on this now — don't serve the pre-rate cache
    res.status(201).json(rate);
  } catch (e) {
    if (e instanceof fxRates.FxRateError) return res.status(e.status).json({ error: e.message });
    console.error("[org] set fx rate failed", e);
    res.status(500).json({ error: "internal error" });
  }
});

router.delete("/fx-rates/:id", requireMinRole("manager"), async (req, res) => {
  try {
    const deleted = await fxRates.deleteRate(req.user.orgId, req.params.id, req.user.id);
    invalidateOrgAnalyticsCache(req.user.orgId);
    res.json(deleted);
  } catch (e) {
    if (e instanceof fxRates.FxRateError) return res.status(e.status).json({ error: e.message });
    console.error("[org] delete fx rate failed", e);
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
