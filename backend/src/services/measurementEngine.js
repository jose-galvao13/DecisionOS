/* ---------------------------------------------------------------
   MEASUREMENT ENGINE — P2 ("Action -> Measurement" automatizada).

   This is the piece STATUS.md flagged as missing for the product to be
   "verdadeiramente closed-loop": until now, `actual_outcome` was always
   typed in by a manager (decisionRecords.recordOutcome). This module
   closes that gap for the two impact metrics decisionEngine.js actually
   produces that are a straight sum over transactions — `revenue` and
   `gross_profit` — by comparing a baseline window (captured once, when
   the decision moved to in_progress — see decisionRecords.js's
   captureBaseline) against the same-length window ending when the
   decision's measurement_window_days have elapsed.

   What this deliberately does NOT do:
   - It does not claim causality. The recorded outcome is a plain
     before/after delta on one metric; anything else that moved revenue
     or margin in the same window (seasonality, a pricing change, a new
     competitor) moves this number too. `notes` on the recorded outcome
     says this explicitly every time, the same way simulateLevers()
     never calls its estimated range a "90% CI".
   - It does not run for metrics it can't compute this way
     (`revenue_at_risk`, `revenue_concentration_pct`, `annual_gross_profit`,
     or any decision with no expected_impact / no baseline at all).
     Those stay manual-only, same as before this module existed.
   - It never overwrites a `manual` outcome, and it only ever measures a
     decision once (`actual_outcome IS NULL` is part of the due query).

   Runs in two ways, exactly like worker.js's job queue:
   1. Periodically, from server.js's process (see startMeasurementLoop
      below), on an interval measured in hours, not milliseconds — this
      is a "did 60 days pass" check, not a queue drain.
   2. On demand via POST /api/decision-log/measure-due (manager+), for
      testing and demos where nobody can actually wait 60 days.
----------------------------------------------------------------*/
import { pool } from "../db/pool.js";
import { loadOrgTransactions, sumMetricInRange } from "./analyticsEngine.js";
import { recordOutcome, DecisionError } from "./decisionRecords.js";

/** Metrics this module knows how to turn into a date-range sum. Anything
 *  else (revenue_at_risk, revenue_concentration_pct, annual_gross_profit,
 *  ...) is intentionally left out — see file header. */
const COMPUTABLE_METRICS = new Set(["revenue", "gross_profit"]);

/** Decisions where the measurement window has elapsed, a baseline exists
 *  to compare against, and nobody has recorded an outcome yet (manual or
 *  automatic). Ordered oldest-due-first so a backlog drains in the order
 *  it built up, same convention as jobQueue.js's claimNextJob(). */
export async function findDueMeasurements(orgId = null) {
  const conditions = [
    "status = 'in_progress'",
    "actual_outcome IS NULL",
    "started_at IS NOT NULL",
    "baseline_metric IS NOT NULL",
    "started_at + (measurement_window_days || ' days')::interval <= now()",
  ];
  const params = [];
  if (orgId) { params.push(orgId); conditions.push(`org_id = $${params.length}`); }
  const { rows } = await pool.query(
    `SELECT * FROM decisions WHERE ${conditions.join(" AND ")} ORDER BY started_at ASC LIMIT 100`,
    params
  );
  return rows;
}

/** Computes and records one decision's outcome from real transaction
 *  data. Returns the updated decision, or null if this decision's metric
 *  isn't one we can compute automatically (caller should leave it for a
 *  manager, not treat this as an error). */
export async function measureDecision(decision) {
  const baseline = decision.baseline_metric;
  const metric = baseline?.metric;
  if (!COMPUTABLE_METRICS.has(metric)) return null;

  const windowDays = decision.measurement_window_days;
  const from = new Date(decision.started_at);
  const to = new Date(from.getTime() + windowDays * 24 * 60 * 60 * 1000);

  const txs = await loadOrgTransactions(decision.org_id);
  const observed = sumMetricInRange(txs, metric, from, to);
  if (observed == null) return null;

  // The "impact" is the delta vs. baseline, in the same units/sign
  // convention decisionEngine.js's impact.low/high already use — this is
  // what makes computeVariance()'s "within expected range" check
  // meaningful, not just two unrelated numbers.
  const impact = Math.round(observed - baseline.value);
  const notes =
    `Medido automaticamente: ${metric === "revenue" ? "receita" : "lucro bruto"} observado(a) ` +
    `de ${from.toISOString().slice(0, 10)} a ${to.toISOString().slice(0, 10)} ` +
    `(${Math.round(observed)}) vs. baseline dos ${windowDays} dias antes do início ` +
    `(${baseline.value}) = impacto de ${impact}. Não é um teste causal — outros fatores ` +
    `no mesmo período também afetam esta métrica.`;

  return recordOutcome(decision.org_id, decision.id, null, {
    value: impact,
    currency: decision.expected_impact?.currency || "EUR",
    notes,
    measuredAt: to.toISOString().slice(0, 10),
    source: "automatic",
  });
}

/** Drains every currently-due decision across all orgs. Returns a small
 *  summary instead of throwing on the first failure — one org's bad data
 *  shouldn't block another org's measurement, same reasoning as
 *  worker.js's runOnce() catching per-job instead of per-tick. */
export async function runDueMeasurements(orgId = null) {
  const due = await findDueMeasurements(orgId);
  const results = { checked: due.length, measured: 0, skipped: 0, failed: 0, errors: [] };
  for (const decision of due) {
    try {
      const updated = await measureDecision(decision);
      if (updated) results.measured += 1;
      else results.skipped += 1; // metric not computable automatically — left for a manager
    } catch (e) {
      results.failed += 1;
      results.errors.push({ decisionId: decision.id, message: e instanceof DecisionError ? e.message : "internal error" });
      console.error(`[measurementEngine] failed to measure decision ${decision.id}:`, e.message);
    }
  }
  return results;
}

const POLL_INTERVAL_MS = Number(process.env.MEASUREMENT_POLL_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6h default — this checks a date, not a queue
let timer = null;

/** Started from server.js alongside startWorker(). Not started by tests
 *  or by the standalone worker process — call runDueMeasurements()
 *  directly there instead, same as worker.js exports runOnce(). */
export function startMeasurementLoop() {
  if (timer) return;
  console.log(`[measurementEngine] checking for due measurements every ${POLL_INTERVAL_MS}ms`);
  const tick = async () => {
    try {
      const result = await runDueMeasurements();
      if (result.checked > 0) console.log("[measurementEngine] tick:", result);
    } catch (e) {
      console.error("[measurementEngine] tick failed:", e.message);
    } finally {
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };
  timer = setTimeout(tick, POLL_INTERVAL_MS);
}

export function stopMeasurementLoop() {
  if (timer) clearTimeout(timer);
  timer = null;
}
