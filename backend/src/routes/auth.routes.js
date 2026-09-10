import { Router } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signToken } from "../auth/jwt.js";
import { requireAuth } from "../auth/middleware.js";
import { writeAudit } from "../audit/auditLog.js";

const router = Router();

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, orgId: u.org_id };
}

/** Creates a brand-new Organization plus its first user (role: owner).
 *  This is the only way to create an org in FASE 1 — every other user is
 *  added by an admin/owner via POST /api/org/users. */
router.post("/register", async (req, res) => {
  const { orgName, name, email, password } = req.body || {};
  if (!orgName || !name || !email || !password) {
    return res.status(400).json({ error: "orgName, name, email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "password must be at least 8 characters" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT 1 FROM users WHERE email = $1", [email.toLowerCase()]);
    if (existing.rows.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "an account with this email already exists" });
    }
    const orgId = randomUUID();
    await client.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, orgName]);
    const userId = randomUUID();
    const passwordHash = await hashPassword(password);
    await client.query(
      `INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5,'owner')`,
      [userId, orgId, email.toLowerCase(), passwordHash, name]
    );
    await client.query("COMMIT");

    const user = { id: userId, org_id: orgId, email: email.toLowerCase(), name, role: "owner" };
    await writeAudit({ orgId, userId, action: "organization.created", objectType: "organization", objectId: orgId, after: { name: orgName } });
    const token = signToken({ sub: user.id, orgId: user.org_id, role: user.role, email: user.email });
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[/api/auth/register]", e);
    res.status(500).json({ error: "registration failed" });
  } finally {
    client.release();
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email and password are required" });

  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
  const user = rows[0];
  // Same generic error whether the email doesn't exist or the password is
  // wrong — don't leak which one it was.
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: "invalid email or password" });
  }
  const token = signToken({ sub: user.id, orgId: user.org_id, role: user.role, email: user.email });
  res.json({ token, user: publicUser(user) });
});

router.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: "user not found" });
  res.json({ user: publicUser(rows[0]) });
});

export default router;
