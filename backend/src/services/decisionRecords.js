/* ---------------------------------------------------------------
   DECISION RECORDS — P1 ("Decision creation", "Decision history",
   "Decision owner", "Approval workflow", "Expected vs actual
   outcome", "Decision ROI").

   This is the persisted half of the product loop
   (DETECT -> EXPLAIN -> RECOMMEND -> SIMULATE -> DECIDE -> ACT ->
   MEASURE -> LEARN). GET /api/decisions (decisions.routes.js) is the
   DETECT/EXPLAIN part — it recomputes decisionEngine.js fresh from
   current data on every call, good for "what does the data say right
   now" but nothing you can own, approve, or measure against later.
   This module is the DECIDE -> ACT -> MEASURE -> LEARN part: an
   actual row that records who's accountable, whether it was
   approved, and — once someone measures it — whether it worked.

   State machine (decisions.status):
     proposed -> pending_approval -> approved -> in_progress -> completed
                                   -> rejected
     any non-terminal status -> archived

   Every transition is audited (audit_log, same table/helper every
   other mutation in this app already uses) so "who approved this and
   when" is always answerable, not just a status enum.
----------------------------------------------------------------*/
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { writeAudit } from "../audit/auditLog.js";
import { loadOrgTransactions, sumMetricInRange } from "./analyticsEngine.js";

const TRANSITIONS = {
  proposed: ["pending_approval", "archived"],
  pending_approval: ["approved", "rejected", "archived"],
  approved: ["in_progress", "archived"],
  in_progress: ["completed", "archived"],
  rejected: ["proposed", "archived"], // can be revised and resubmitted
  completed: ["archived"],
  archived: [],
};

export class DecisionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function assertTransition(from, to) {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new DecisionError(`cannot move a decision from '${from}' to '${to}' (allowed: ${TRANSITIONS[from]?.join(", ") || "none"})`);
  }
}

/** Straight subtraction, not a projection — ROI is only ever computed
 *  once a real actual_outcome has been recorded; never estimated or
 *  backfilled from the original expected_impact. Returns null (not 0 or
 *  a guess) when there isn't enough to compute it from. */
function computeROI({ actualOutcome, investmentCost }) {
  if (!actualOutcome || typeof actualOutcome.value !== "number") return null;
  if (investmentCost == null || investmentCost === 0) return null;
  const netGain = actualOutcome.value - investmentCost;
  return {
    netGain: Math.round(netGain),
    roiPct: Number(((netGain / Math.abs(investmentCost)) * 100).toFixed(1)),
    basis: `(actual outcome ${actualOutcome.value} − investment cost ${investmentCost}) / investment cost`,
  };
}

/** Expected vs actual — only meaningful once actual_outcome exists.
 *  Compares against the expected_impact range frozen at creation time,
 *  not a re-derived number, so this can't silently drift if the Decision
 *  Engine's math changes later. */
function computeVariance({ expectedImpact, actualOutcome }) {
  if (!actualOutcome || typeof actualOutcome.value !== "number" || !expectedImpact) return null;
  const { low, high } = expectedImpact;
  const withinRange = low != null && high != null ? actualOutcome.value >= Math.min(low, high) && actualOutcome.value <= Math.max(low, high) : null;
  const midpoint = low != null && high != null ? (low + high) / 2 : low ?? high ?? null;
  const deltaVsMidpoint = midpoint != null ? Math.round(actualOutcome.value - midpoint) : null;
  return { withinExpectedRange: withinRange, deltaVsMidpoint };
}

function enrich(row) {
  const roi = computeROI({ actualOutcome: row.actual_outcome, investmentCost: row.investment_cost });
  const variance = computeVariance({ expectedImpact: row.expected_impact, actualOutcome: row.actual_outcome });
  return { ...row, roi, variance };
}

export async function createDecision({
  orgId, createdBy, title, description, recommendation, ownerId,
  sourceType, confidence, sourceSnapshot, expectedImpact, targetDate, investmentCost,
  measurementWindowDays,
}) {
  if (!title || !description) throw new DecisionError("title and description are required");
  if (ownerId) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND org_id = $2`, [ownerId, orgId]);
    if (!rows.length) throw new DecisionError("ownerId must be a user in this organization");
  }
  // P2 "60 days later" default — overridable per decision (e.g. a
  // pricing change might be measurable in 14 days; a hiring decision
  // might need 120), same idea as `target_date` being optional context
  // rather than something the engine enforces.
  const windowDays = Number.isFinite(Number(measurementWindowDays)) && Number(measurementWindowDays) > 0
    ? Math.round(Number(measurementWindowDays)) : 60;
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO decisions
       (id, org_id, title, description, recommendation, owner_id, created_by,
        source_type, confidence, source_snapshot, expected_impact, target_date, investment_cost, measurement_window_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [id, orgId, title, description, recommendation || null, ownerId || null, createdBy,
      sourceType || "manual", confidence ?? null, sourceSnapshot ? JSON.stringify(sourceSnapshot) : null,
      expectedImpact ? JSON.stringify(expectedImpact) : null, targetDate || null, investmentCost ?? null, windowDays]
  );
  await writeAudit({ orgId, userId: createdBy, action: "decision.created", objectType: "decision", objectId: id, after: rows[0] });
  return enrich(rows[0]);
}

export async function listDecisions(orgId, { status, ownerId, limit = 20, offset = 0 } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const conditions = ["org_id = $1"];
  const params = [orgId];
  if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
  if (ownerId) { params.push(ownerId); conditions.push(`owner_id = $${params.length}`); }
  const where = conditions.join(" AND ");

  const { rows } = await pool.query(
    `SELECT * FROM decisions WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, cappedLimit, safeOffset]
  );
  const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM decisions WHERE ${where}`, params);
  return { decisions: rows.map(enrich), total: Number(countRows[0].count), limit: cappedLimit, offset: safeOffset };
}

export async function getDecision(orgId, id) {
  const { rows } = await pool.query(`SELECT * FROM decisions WHERE id = $1 AND org_id = $2`, [id, orgId]);
  return rows[0] ? enrich(rows[0]) : null;
}

/** Generic status-transition helper backing submit/start — enforces the
 *  state machine and always audits. approve/reject/outcome have their own
 *  functions below since they each set extra columns beyond `status`. */
async function transition(orgId, id, userId, toStatus, action) {
  const current = await getDecision(orgId, id);
  if (!current) throw new DecisionError("decision not found", 404);
  assertTransition(current.status, toStatus);
  const { rows } = await pool.query(
    `UPDATE decisions SET status = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, orgId, toStatus]
  );
  await writeAudit({ orgId, userId, action, objectType: "decision", objectId: id, before: { status: current.status }, after: { status: toStatus } });
  return enrich(rows[0]);
}

export async function submitForApproval(orgId, id, userId) {
  return transition(orgId, id, userId, "pending_approval", "decision.submitted");
}

export async function approveDecision(orgId, id, userId) {
  const current = await getDecision(orgId, id);
  if (!current) throw new DecisionError("decision not found", 404);
  assertTransition(current.status, "approved");
  const { rows } = await pool.query(
    `UPDATE decisions SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, orgId, userId]
  );
  await writeAudit({ orgId, userId, action: "decision.approved", objectType: "decision", objectId: id, before: { status: current.status }, after: { status: "approved", approvedBy: userId } });
  return enrich(rows[0]);
}

export async function rejectDecision(orgId, id, userId, reason) {
  const current = await getDecision(orgId, id);
  if (!current) throw new DecisionError("decision not found", 404);
  assertTransition(current.status, "rejected");
  const { rows } = await pool.query(
    `UPDATE decisions SET status = 'rejected', rejected_reason = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, orgId, reason || null]
  );
  await writeAudit({ orgId, userId, action: "decision.rejected", objectType: "decision", objectId: id, before: { status: current.status }, after: { status: "rejected", reason } });
  return enrich(rows[0]);
}

/** Snapshot of the metric right before a decision is acted on — the
 *  "before" half of an automatic before/after comparison. Window length
 *  mirrors the decision's own measurement_window_days, so baseline and
 *  observed periods are the same size (a 60-day baseline vs. a 7-day
 *  observed window would make the delta meaningless). Returns null (not
 *  0) when the metric isn't one this can compute automatically, or when
 *  there's no expected_impact at all — recordOutcome/measurementEngine.js
 *  both already treat a null baseline as "manual outcome only", never as
 *  zero.
 */
async function captureBaseline(orgId, expectedImpact, windowDays) {
  const metric = expectedImpact?.metric;
  if (!metric || (metric !== "revenue" && metric !== "gross_profit")) return null;
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0 ? Number(windowDays) : 60;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const txs = await loadOrgTransactions(orgId);
  const value = sumMetricInRange(txs, metric, from, to);
  if (value == null) return null;
  return { metric, value: Math.round(value), windowDays: days, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), computedAt: new Date().toISOString() };
}

export async function startDecision(orgId, id, userId) {
  const current = await getDecision(orgId, id);
  if (!current) throw new DecisionError("decision not found", 404);
  assertTransition(current.status, "in_progress");
  const baseline = await captureBaseline(orgId, current.expected_impact, current.measurement_window_days);
  const { rows } = await pool.query(
    `UPDATE decisions SET status = 'in_progress', started_at = now(), baseline_metric = $3, updated_at = now()
     WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, orgId, baseline ? JSON.stringify(baseline) : null]
  );
  await writeAudit({
    orgId, userId, action: "decision.started", objectType: "decision", objectId: id,
    before: { status: current.status }, after: { status: "in_progress", baselineCaptured: !!baseline },
  });
  return enrich(rows[0]);
}

export async function archiveDecision(orgId, id, userId) {
  const current = await getDecision(orgId, id);
  if (!current) throw new DecisionError("decision not found", 404);
  assertTransition(current.status, "archived");
  const { rows } = await pool.query(
    `UPDATE decisions SET status = 'archived', updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, orgId]
  );
  await writeAudit({ orgId, userId, action: "decision.archived", objectType: "decision", objectId: id, before: { status: current.status }, after: { status: "archived" } });
  return enrich(rows[0]);
}

/** Records the real-world result — "Expected vs actual outcome" / "Decision
 *  ROI". Only valid once a decision is in_progress or completed (recording
 *  an outcome for something never approved/started doesn't make sense).
 *  Moves status to 'completed' if it wasn't already. */
export async function recordOutcome(orgId, id, userId, { value, currency = "EUR", notes, measuredAt, source = "manual" }) {
  if (typeof value !== "number") throw new DecisionError("actual outcome 'value' must be a number");
  if (!["manual", "automatic"].includes(source)) throw new DecisionError("source must be 'manual' or 'automatic'");
  const current = await getDecision(orgId, id);
  if (!current) throw new DecisionError("decision not found", 404);
  if (!["in_progress", "completed"].includes(current.status)) {
    throw new DecisionError(`can only record an outcome for a decision that is in_progress or completed (this one is '${current.status}')`);
  }
  const actualOutcome = { value, currency, notes: notes || null, measuredAt: measuredAt || new Date().toISOString().slice(0, 10), source };
  const { rows } = await pool.query(
    `UPDATE decisions SET actual_outcome = $3, outcome_source = $4, status = 'completed', updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`,
    [id, orgId, JSON.stringify(actualOutcome), source]
  );
  await writeAudit({
    orgId, userId: userId || null,
    action: source === "automatic" ? "decision.outcome_recorded_automatically" : "decision.outcome_recorded",
    objectType: "decision", objectId: id, after: actualOutcome,
  });
  return enrich(rows[0]);
}
