/* Data-quality report shapes.
   The frontend computes { healthPct, missingPct, duplicates, invalidIds,
   inconsistent, rows } (lib/mapping.js -> computeDataQuality); the backend
   stores { score, issues, stats } (services/dataQuality.js -> assessQuality).
   Everything that displays a report goes through this so either shape works. */

function toFiniteNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function issueCount(issues, ...codes) {
  return issues.filter((i) => codes.includes(i.code) || codes.includes(i.type)).reduce((sum, i) => sum + (toFiniteNumber(i.count) ?? 1), 0);
}

export function normalizeQuality(quality) {
  if (!quality) return null;

  // Frontend-computed shape (already has everything). healthPct is coerced
  // too, so a numeric string can never turn into "NaN%" further down.
  if (quality.healthPct !== undefined) {
    const healthPct = toFiniteNumber(quality.healthPct);
    return healthPct === null ? null : { ...quality, healthPct };
  }

  // Backend shape: { score, issues, stats? }.
  // Postgres NUMERIC reaches the browser as a *string* ("100.0"), so a
  // `typeof score === "number"` check silently rejected every report that was
  // loaded from the server (i.e. everything after a page reload).
  const score = toFiniteNumber(quality.score);
  if (score === null) return null;

  const issues = Array.isArray(quality.issues) ? quality.issues : [];
  const stats = quality.stats && typeof quality.stats === "object" ? quality.stats : null;
  const missingPct = stats ? toFiniteNumber(stats.missingPct) : null;

  return {
    healthPct: score,
    // null = "we don't know" (report saved before stats existed) -> UI shows "—".
    missingPct: missingPct === null ? null : `${missingPct.toFixed(1)}%`,
    duplicates: stats ? toFiniteNumber(stats.duplicates) : null,
    invalidIds: stats ? toFiniteNumber(stats.invalidIds) : issueCount(issues, "missing_customer_id", "invalid_id") || null,
    inconsistent: stats ? toFiniteNumber(stats.inconsistent) : null,
    unmapped: issueCount(issues, "unmapped"),
    anomalies: issueCount(issues, "anomaly"),
    rows: (stats ? toFiniteNumber(stats.rows) : null) ?? toFiniteNumber(quality.rows),
    issues,
  };
}

/* ---- Issue messages --------------------------------------------------
   The backend used to store the sentence itself, in Portuguese
   ("100.0% das receitas válidas"), so it never followed the language switch.
   Issues carry a stable `code` + numbers, and the sentence is built here from
   the i18n dictionary. Older reports (stored before `params` existed) only
   have `count` and the Portuguese `message`, so the numbers are recovered
   from those. */
const ISSUE_KEYS = {
  missing_customer_id: "dq.issue.missing_customer_id",
  invalid_dates: "dq.issue.invalid_dates",
  missing_revenue: "dq.issue.missing_revenue",
  mixed_currencies: "dq.issue.mixed_currencies",
  valid_revenue_pct: "dq.issue.valid_revenue_pct",
};

function issueParams(issue) {
  const p = { ...(issue.params || {}) };
  const msg = typeof issue.message === "string" ? issue.message : "";
  if (p.n === undefined && issue.code !== "valid_revenue_pct") p.n = toFiniteNumber(issue.count) ?? 0;
  if (issue.code === "valid_revenue_pct" && p.pct === undefined) {
    const m = msg.match(/^\s*(\d+(?:[.,]\d+)?)\s*%/);
    p.pct = m ? Number(m[1].replace(",", ".")) : null;
  }
  if (issue.code === "mixed_currencies" && p.list === undefined) {
    const m = msg.match(/\(([^)]*)\)/);
    p.list = m ? m[1] : "";
  }
  return p;
}

/** Human-readable, translated text for one quality issue. */
export function describeIssue(issue, t, locale) {
  const key = ISSUE_KEYS[issue?.code];
  if (!key) return issue?.message || issue?.code || issue?.type || "";
  const p = issueParams(issue);
  if (issue.code === "valid_revenue_pct" && p.pct === null) return issue.message || "";
  const vars = { ...p };
  if (typeof p.pct === "number") vars.pct = p.pct.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (typeof p.n === "number") vars.n = p.n.toLocaleString(locale);
  return t(key, vars);
}
