/* ---------------------------------------------------------------
   NOTIFICATIONS — the bell in the header.

   Nothing here is stored except who has read what. Every notification is
   derived, on request, from data that already exists, so it always reflects
   the current state and disappears by itself once the reason is gone (a
   decision that got approved stops being "waiting for approval").

   Sources:
     - decisions waiting for approval               (managers and above)
     - decisions you own/created that were approved or rejected  (last 14 days)
     - outcomes measured for decisions              (last 14 days; yours, or all for managers)
     - imports that failed                          (managers and above, last 7 days)
     - a poor data-quality report on the active file
     - red-severity findings from the Decision Engine

   The backend sends a stable `kind` + raw values (`params`), never a
   sentence: the wording is built in the browser from the language
   dictionary, so it follows the language switch.
----------------------------------------------------------------*/
import { pool } from "../db/pool.js";
import { ROLE_RANK } from "../auth/middleware.js";
import { computeAnalyticsForOrg } from "./analyticsEngine.js";
import { generateDecisions } from "./decisionEngine.js";
import { getActiveDataSourceIds } from "./activeSource.js";

const RECENT_DECISION_DAYS = 14;
const RECENT_IMPORT_FAILURE_DAYS = 7;
const QUALITY_ALERT_BELOW = 70; // the same line the Data Quality Center draws for "red"
const MAX_NOTIFICATIONS = 30;
const SEVERITY_RANK = { red: 3, yellow: 2, blue: 1, green: 0 };

const iso = (d) => (d ? new Date(d).toISOString() : null);

async function approvalsPending(orgId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.updated_at, u.name AS created_by_name
     FROM decisions d LEFT JOIN users u ON u.id = d.created_by
     WHERE d.org_id = $1 AND d.status = 'pending_approval'
     ORDER BY d.updated_at DESC LIMIT 10`,
    [orgId]
  );
  return rows.map((r) => ({
    key: `approval_pending:${r.id}`, kind: "approval_pending", severity: "yellow",
    params: { title: r.title, by: r.created_by_name || null }, createdAt: iso(r.updated_at), target: { view: "decisionLog" },
  }));
}

async function myDecisionsResolved(orgId, userId) {
  const { rows } = await pool.query(
    `SELECT id, title, status, rejected_reason, updated_at FROM decisions
     WHERE org_id = $1 AND status IN ('approved','rejected') AND (owner_id = $2 OR created_by = $2)
       AND updated_at > now() - ($3::int * interval '1 day')
     ORDER BY updated_at DESC LIMIT 10`,
    [orgId, userId, RECENT_DECISION_DAYS]
  );
  return rows.map((r) => ({
    key: `decision_${r.status}:${r.id}`, kind: `decision_${r.status}`, severity: r.status === "rejected" ? "yellow" : "green",
    params: { title: r.title, reason: r.rejected_reason || null }, createdAt: iso(r.updated_at), target: { view: "decisionLog" },
  }));
}

async function outcomesMeasured(orgId, userId, seesAll) {
  const { rows } = await pool.query(
    `SELECT id, title, (actual_outcome->>'measuredAt')::timestamptz AS measured_at FROM decisions
     WHERE org_id = $1 AND actual_outcome IS NOT NULL
       AND (actual_outcome->>'measuredAt')::timestamptz > now() - ($3::int * interval '1 day')
       AND ($4::boolean OR owner_id = $2 OR created_by = $2)
     ORDER BY measured_at DESC LIMIT 10`,
    [orgId, userId, RECENT_DECISION_DAYS, seesAll]
  );
  return rows.map((r) => ({
    key: `outcome_measured:${r.id}`, kind: "outcome_measured", severity: "blue",
    params: { title: r.title }, createdAt: iso(r.measured_at), target: { view: "decisionLog" },
  }));
}

async function importsFailed(orgId) {
  const { rows } = await pool.query(
    `SELECT j.id, j.error, j.finished_at, ds.name
     FROM jobs j LEFT JOIN data_sources ds ON ds.id = j.data_source_id
     WHERE j.org_id = $1 AND j.status = 'failed' AND j.finished_at > now() - ($2::int * interval '1 day')
     ORDER BY j.finished_at DESC LIMIT 5`,
    [orgId, RECENT_IMPORT_FAILURE_DAYS]
  );
  return rows.map((r) => ({
    key: `import_failed:${r.id}`, kind: "import_failed", severity: "red",
    params: { name: r.name || null, error: r.error || null }, createdAt: iso(r.finished_at), target: { view: "data" },
  }));
}

// With several files active at once, a single bad one shouldn't hide behind
// a good one's score — this looks at every active source's latest report
// and surfaces the worst, so one poor-quality file always gets flagged.
async function poorDataQuality(orgId) {
  const activeIds = await getActiveDataSourceIds(orgId);
  if (!activeIds.length) return [];
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (r.data_source_id) r.id, r.data_source_id, r.score, r.created_at, ds.name
     FROM data_quality_reports r JOIN data_sources ds ON ds.id = r.data_source_id
     WHERE r.org_id = $1 AND r.data_source_id = ANY($2)
     ORDER BY r.data_source_id, r.created_at DESC`,
    [orgId, activeIds]
  );
  const worst = rows
    .filter((r) => Number(r.score) < QUALITY_ALERT_BELOW)
    .sort((a, b) => Number(a.score) - Number(b.score))[0];
  if (!worst) return [];
  return [{
    key: `low_quality:${worst.id}`, kind: "low_quality", severity: "red",
    params: { name: worst.name, score: Math.round(Number(worst.score)) }, createdAt: iso(worst.created_at), target: { view: "dataQuality" },
  }];
}

async function redFindings(orgId) {
  const analytics = await computeAnalyticsForOrg(orgId, {});
  if (!analytics) return [];
  const freshness = `${analytics.count}:${analytics.dateRange?.max ? new Date(analytics.dateRange.max).toISOString().slice(0, 10) : ""}`;
  return generateDecisions(analytics)
    .filter((d) => d.severity === "red")
    .slice(0, 3)
    .map((d) => ({
      // Tied to the data it was found in: after a new import that still shows the
      // same problem it is a new notification, not one you already dismissed.
      key: `risk:${d.type}:${freshness}`, kind: "risk", severity: "red",
      params: { type: d.type, impact: typeof d.impact?.low === "number" ? { value: d.impact.low, currency: d.impact.currency || null } : null },
      createdAt: null, target: { view: "overview" },
    }));
}

/** Runs one source; a failure in it must never take the whole bell down. */
async function safely(name, fn) {
  try { return await fn(); } catch (e) { console.error(`[notifications] ${name} failed:`, e.message); return []; }
}

export async function buildNotifications(user) {
  const { orgId, id: userId } = user;
  const isManager = ROLE_RANK[user.role] >= ROLE_RANK.manager;

  const groups = await Promise.all([
    isManager ? safely("approvals", () => approvalsPending(orgId)) : [],
    safely("my decisions", () => myDecisionsResolved(orgId, userId)),
    safely("outcomes", () => outcomesMeasured(orgId, userId, isManager)),
    isManager ? safely("imports", () => importsFailed(orgId)) : [],
    safely("data quality", () => poorDataQuality(orgId)),
    safely("findings", () => redFindings(orgId)),
  ]);
  const all = groups.flat();

  const readKeys = new Set();
  if (all.length) {
    const { rows } = await pool.query(`SELECT key FROM notification_reads WHERE user_id = $1 AND key = ANY($2::text[])`, [userId, all.map((n) => n.key)]);
    rows.forEach((r) => readKeys.add(r.key));
  }
  const notifications = all
    .map((n) => ({ ...n, read: readKeys.has(n.key) }))
    .sort((a, b) =>
      Number(a.read) - Number(b.read) ||
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0)
    )
    .slice(0, MAX_NOTIFICATIONS);
  return { notifications, unreadCount: notifications.filter((n) => !n.read).length };
}

const MAX_KEYS_PER_REQUEST = 100;
const MAX_KEY_LENGTH = 200;

export async function markRead(userId, keys) {
  const clean = [...new Set((keys || []).filter((k) => typeof k === "string" && k && k.length <= MAX_KEY_LENGTH))].slice(0, MAX_KEYS_PER_REQUEST);
  if (!clean.length) return 0;
  await pool.query(
    `INSERT INTO notification_reads (user_id, key) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
    [userId, clean]
  );
  // Read marks for things that stopped existing long ago would only pile up.
  await pool.query(`DELETE FROM notification_reads WHERE user_id = $1 AND read_at < now() - interval '90 days'`, [userId]);
  return clean.length;
}
