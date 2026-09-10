import { Router } from "express";
import { requireAuth, requireMinRole } from "../auth/middleware.js";
import { pool } from "../db/pool.js";
import * as records from "../services/decisionRecords.js";
import * as actions from "../services/decisionActions.js";
import { runDueMeasurements } from "../services/measurementEngine.js";

const router = Router();
router.use(requireAuth);

function handleError(res, e) {
  if (e instanceof records.DecisionError || e instanceof actions.ActionError) return res.status(e.status).json({ error: e.message });
  console.error("[decision-log]", e);
  return res.status(500).json({ error: "internal error" });
}

/**
 * POST /api/decision-log
 * Creates a persisted decision — P1 "Decision creation". Can originate
 * from a detected decision (GET /api/decisions — pass its `type` as
 * sourceType, its confidence, and its evidence/drivers as sourceSnapshot)
 * or from a simulation run (sourceType: 'simulation', sourceSnapshot: the
 * simulation response) or be entirely manual (sourceType omitted).
 */
router.post("/", async (req, res) => {
  try {
    const d = await records.createDecision({
      orgId: req.user.orgId, createdBy: req.user.id,
      title: req.body?.title, description: req.body?.description, recommendation: req.body?.recommendation,
      ownerId: req.body?.ownerId, sourceType: req.body?.sourceType, confidence: req.body?.confidence,
      sourceSnapshot: req.body?.sourceSnapshot, expectedImpact: req.body?.expectedImpact,
      targetDate: req.body?.targetDate, investmentCost: req.body?.investmentCost,
      measurementWindowDays: req.body?.measurementWindowDays,
    });
    res.status(201).json(d);
  } catch (e) { handleError(res, e); }
});

/** GET /api/decision-log — P1 "Decision history". Filter by ?status=,
 *  ?ownerId=; paginated (?limit&offset), same convention as every other
 *  list endpoint in this app. */
router.get("/", async (req, res) => {
  try {
    const result = await records.listDecisions(req.user.orgId, {
      status: req.query.status, ownerId: req.query.ownerId,
      limit: req.query.limit, offset: req.query.offset,
    });
    res.json(result);
  } catch (e) { handleError(res, e); }
});

router.get("/:id", async (req, res) => {
  const d = await records.getDecision(req.user.orgId, req.params.id);
  if (!d) return res.status(404).json({ error: "decision not found" });
  res.json(d);
});

/** PATCH /api/decision-log/:id/owner — P1 "Decision owner". Reassignable
 *  at any point in the lifecycle (ownership can change without a status
 *  change), by a manager or above. */
router.patch("/:id/owner", requireMinRole("manager"), async (req, res) => {
  try {
    const d = await records.getDecision(req.user.orgId, req.params.id);
    if (!d) return res.status(404).json({ error: "decision not found" });
    // Reuses createDecision's ownerId-in-this-org validation by going
    // through the same query pattern here directly for a single column.
    if (req.body?.ownerId) {
      const { rows } = await pool.query(`SELECT id FROM users WHERE id = $1 AND org_id = $2`, [req.body.ownerId, req.user.orgId]);
      if (!rows.length) return res.status(400).json({ error: "ownerId must be a user in this organization" });
    }
    const { rows } = await pool.query(
      `UPDATE decisions SET owner_id = $3, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *`,
      [req.params.id, req.user.orgId, req.body?.ownerId || null]
    );
    res.json(rows[0]);
  } catch (e) { handleError(res, e); }
});

/* ------------------------- Approval workflow ------------------------- */
// P1 "Approval workflow": proposed -> pending_approval (anyone who can
// create a decision can submit it) -> approved/rejected (manager+ only —
// the actual gate) -> in_progress -> completed. See decisionRecords.js's
// TRANSITIONS for the full state machine and why each edge exists.

router.post("/:id/submit", async (req, res) => {
  try { res.json(await records.submitForApproval(req.user.orgId, req.params.id, req.user.id)); }
  catch (e) { handleError(res, e); }
});

router.post("/:id/approve", requireMinRole("manager"), async (req, res) => {
  try { res.json(await records.approveDecision(req.user.orgId, req.params.id, req.user.id)); }
  catch (e) { handleError(res, e); }
});

router.post("/:id/reject", requireMinRole("manager"), async (req, res) => {
  try { res.json(await records.rejectDecision(req.user.orgId, req.params.id, req.user.id, req.body?.reason)); }
  catch (e) { handleError(res, e); }
});

router.post("/:id/start", async (req, res) => {
  try { res.json(await records.startDecision(req.user.orgId, req.params.id, req.user.id)); }
  catch (e) { handleError(res, e); }
});

router.post("/:id/archive", async (req, res) => {
  try { res.json(await records.archiveDecision(req.user.orgId, req.params.id, req.user.id)); }
  catch (e) { handleError(res, e); }
});

/**
 * POST /api/decision-log/:id/outcome
 * P1 "Expected vs actual outcome" + "Decision ROI". Body: { value,
 * currency?, notes?, measuredAt? }. `roi` and `variance` (vs. the
 * expected_impact frozen at creation) are computed and included in every
 * response once an outcome exists — see decisionRecords.js's enrich().
 */
router.post("/:id/outcome", requireMinRole("manager"), async (req, res) => {
  try {
    res.json(await records.recordOutcome(req.user.orgId, req.params.id, req.user.id, {
      value: req.body?.value, currency: req.body?.currency, notes: req.body?.notes, measuredAt: req.body?.measuredAt,
    }));
  } catch (e) { handleError(res, e); }
});

/* --------------------------- Actions (P2) ---------------------------- */
// "Decision -> Action": a decision's own checklist. Any authenticated org
// member can add/update actions (same bar as creating a decision itself);
// no separate role gate here, unlike approve/reject/outcome which are
// deliberate approval-authority gates.

router.post("/:id/actions", async (req, res) => {
  try {
    const a = await actions.createAction(req.user.orgId, req.params.id, req.user.id, {
      title: req.body?.title, ownerId: req.body?.ownerId, dueDate: req.body?.dueDate,
    });
    res.status(201).json(a);
  } catch (e) { handleError(res, e); }
});

router.get("/:id/actions", async (req, res) => {
  try { res.json(await actions.listActions(req.user.orgId, req.params.id)); }
  catch (e) { handleError(res, e); }
});

router.patch("/:id/actions/:actionId", async (req, res) => {
  try {
    const a = await actions.updateAction(req.user.orgId, req.params.id, req.params.actionId, req.user.id, {
      title: req.body?.title, ownerId: req.body?.ownerId, status: req.body?.status, dueDate: req.body?.dueDate,
    });
    res.json(a);
  } catch (e) { handleError(res, e); }
});

router.delete("/:id/actions/:actionId", async (req, res) => {
  try { res.json(await actions.deleteAction(req.user.orgId, req.params.id, req.params.actionId, req.user.id)); }
  catch (e) { handleError(res, e); }
});

/* ----------------------- Automatic measurement (P2) ------------------- */
/**
 * POST /api/decision-log/measure-due
 * "Action -> Measurement" automatizada — closes the loop STATUS.md
 * flagged as missing. Finds every decision (across this org only —
 * see note below) whose measurement_window_days elapsed since it started
 * and that hasn't had an outcome recorded yet, and records one
 * automatically from real transaction data (measurementEngine.js).
 *
 * This runs on its own every few hours in the background (server.js ->
 * startMeasurementLoop, which sweeps every org) — this endpoint exists
 * so a demo or a test doesn't have to wait for that timer or for 60 real
 * days to pass, and so a manager can trigger it on demand. Scoped to
 * req.user.orgId, unlike the background sweep, so this can never touch
 * another org's decisions. Gated the same as approve/reject/outcome
 * since it writes actual_outcome, same as those.
 */
router.post("/measure-due", requireMinRole("manager"), async (req, res) => {
  try {
    res.json(await runDueMeasurements(req.user.orgId));
  } catch (e) {
    console.error("[decision-log] measure-due failed", e);
    res.status(500).json({ error: "internal error" });
  }
});

export default router;
