import { Router } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { requireAuth, requireMinRole } from "../auth/middleware.js";
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
    "SELECT id, email, name, role, created_at FROM users WHERE org_id = $1 ORDER BY created_at",
    [req.user.orgId]
  );
  res.json({ users: rows });
});

const INVITABLE_ROLES = ["admin", "finance", "manager", "viewer"];

/** Admin/owner directly creates a teammate. (A real invite-by-email flow
 *  with its own accept link is a small addition on top of this — deferred,
 *  not blocking FASE 1.) */
router.post("/users", requireMinRole("admin"), async (req, res) => {
  const { email, name, password, role } = req.body || {};
  if (!email || !name || !password || !role) {
    return res.status(400).json({ error: "email, name, password and role are required" });
  }
  if (!INVITABLE_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${INVITABLE_ROLES.join(", ")}` });
  }
  // Only an owner can create another admin — an admin can't promote peers.
  if (role === "admin" && req.user.role !== "owner") {
    return res.status(403).json({ error: "only an owner can create an admin" });
  }
  const existing = await pool.query("SELECT 1 FROM users WHERE email = $1", [email.toLowerCase()]);
  if (existing.rows.length) return res.status(409).json({ error: "a user with this email already exists" });

  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, req.user.orgId, email.toLowerCase(), passwordHash, name, role]
  );
  await writeAudit({ orgId: req.user.orgId, userId: req.user.id, action: "user.created", objectType: "user", objectId: id, after: { email, role } });
  res.status(201).json({ id, email: email.toLowerCase(), name, role });
});

router.patch("/users/:id/role", requireMinRole("owner"), async (req, res) => {
  const { role } = req.body || {};
  if (!INVITABLE_ROLES.includes(role) && role !== "owner") {
    return res.status(400).json({ error: "invalid role" });
  }
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1 AND org_id = $2", [req.params.id, req.user.orgId]);
  if (!rows.length) return res.status(404).json({ error: "user not found" });
  const before = rows[0].role;
  await pool.query("UPDATE users SET role = $1 WHERE id = $2", [role, req.params.id]);
  await writeAudit({
    orgId: req.user.orgId, userId: req.user.id, action: "user.role_changed",
    objectType: "user", objectId: req.params.id, before: { role: before }, after: { role },
  });
  res.json({ id: req.params.id, role });
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
