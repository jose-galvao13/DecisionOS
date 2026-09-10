/* ---------------------------------------------------------------
   DECISION ACTIONS — P2 ("Decision -> Action"). Until now `in_progress`
   was the only trace that someone was acting on a decision — no
   subtasks, no per-step owner. This gives a decision an optional
   checklist: who is doing what, and whether it's done. Actions don't
   drive the decision's own state machine (see decisionRecords.js) —
   a manager still moves the decision itself through
   approved -> in_progress -> completed explicitly.
----------------------------------------------------------------*/
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { writeAudit } from "../audit/auditLog.js";

export class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function assertDecisionInOrg(orgId, decisionId) {
  const { rows } = await pool.query(`SELECT id FROM decisions WHERE id = $1 AND org_id = $2`, [decisionId, orgId]);
  if (!rows.length) throw new ActionError("decision not found", 404);
}

export async function createAction(orgId, decisionId, userId, { title, ownerId, dueDate }) {
  if (!title) throw new ActionError("title is required");
  await assertDecisionInOrg(orgId, decisionId);
  if (ownerId) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND org_id = $2`, [ownerId, orgId]);
    if (!rows.length) throw new ActionError("ownerId must be a user in this organization");
  }
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO decision_actions (id, decision_id, org_id, title, owner_id, due_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, decisionId, orgId, title, ownerId || null, dueDate || null, userId]
  );
  await writeAudit({ orgId, userId, action: "decision_action.created", objectType: "decision_action", objectId: id, after: rows[0] });
  return rows[0];
}

export async function listActions(orgId, decisionId) {
  await assertDecisionInOrg(orgId, decisionId);
  const { rows } = await pool.query(
    `SELECT * FROM decision_actions WHERE decision_id = $1 AND org_id = $2 ORDER BY created_at ASC`,
    [decisionId, orgId]
  );
  return rows;
}

const VALID_STATUSES = ["todo", "in_progress", "done", "skipped"];

export async function updateAction(orgId, decisionId, actionId, userId, { title, ownerId, status, dueDate }) {
  await assertDecisionInOrg(orgId, decisionId);
  const { rows: existingRows } = await pool.query(
    `SELECT * FROM decision_actions WHERE id = $1 AND decision_id = $2 AND org_id = $3`,
    [actionId, decisionId, orgId]
  );
  const current = existingRows[0];
  if (!current) throw new ActionError("action not found", 404);
  if (status && !VALID_STATUSES.includes(status)) throw new ActionError(`status must be one of: ${VALID_STATUSES.join(", ")}`);
  if (ownerId) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND org_id = $2`, [ownerId, orgId]);
    if (!rows.length) throw new ActionError("ownerId must be a user in this organization");
  }
  const nextStatus = status || current.status;
  const completedAt = nextStatus === "done" ? (current.completed_at || new Date()) : nextStatus === current.status ? current.completed_at : null;
  const { rows } = await pool.query(
    `UPDATE decision_actions
     SET title = $4, owner_id = $5, status = $6, due_date = $7, completed_at = $8, updated_at = now()
     WHERE id = $1 AND decision_id = $2 AND org_id = $3 RETURNING *`,
    [actionId, decisionId, orgId, title ?? current.title, ownerId !== undefined ? ownerId || null : current.owner_id,
      nextStatus, dueDate !== undefined ? dueDate || null : current.due_date, completedAt]
  );
  await writeAudit({
    orgId, userId, action: "decision_action.updated", objectType: "decision_action", objectId: actionId,
    before: current, after: rows[0],
  });
  return rows[0];
}

export async function deleteAction(orgId, decisionId, actionId, userId) {
  await assertDecisionInOrg(orgId, decisionId);
  const { rows } = await pool.query(
    `DELETE FROM decision_actions WHERE id = $1 AND decision_id = $2 AND org_id = $3 RETURNING *`,
    [actionId, decisionId, orgId]
  );
  if (!rows.length) throw new ActionError("action not found", 404);
  await writeAudit({ orgId, userId, action: "decision_action.deleted", objectType: "decision_action", objectId: actionId, before: rows[0] });
  return rows[0];
}
