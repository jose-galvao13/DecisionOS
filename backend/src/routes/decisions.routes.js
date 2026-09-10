import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { computeAnalyticsForOrg } from "../services/analyticsEngine.js";
import { generateDecisions } from "../services/decisionEngine.js";

const router = Router();
router.use(requireAuth);

function filtersFromQuery(q) {
  return { period: q.period, product: q.product, region: q.region, channel: q.channel };
}

/**
 * GET /api/decisions
 * Same optional filters as /api/analytics/* (period, product, region,
 * channel). Runs the Decision Engine against this org's own analytics —
 * every decision returned traces back to computeAnalyticsForOrg's output,
 * nothing here is computed independently of it.
 *
 * P0 credibility fix: this endpoint existed but nothing ever called it —
 * the on-screen Decision Feed (Overview page) only ever showed
 * lib/metrics.js's computeAlerts() (simple KPI-threshold trips, no
 * confidence or evidence), while the real, evidence-scored Decision
 * Engine sat unused except as an AI-tool call. `dataCoverage` here is
 * what the frontend now renders once per feed so every decision's
 * confidence can be read against how much data backs it.
 */
router.get("/", async (req, res) => {
  const analytics = await computeAnalyticsForOrg(req.user.orgId, filtersFromQuery(req.query));
  if (!analytics) {
    return res.json({ decisions: [], dataCoverage: { transactions: 0, monthsCovered: 0, dateRange: null } });
  }
  res.json({
    decisions: generateDecisions(analytics),
    dataCoverage: {
      transactions: analytics.count,
      monthsCovered: analytics.monthly.length,
      dateRange: { from: analytics.dateRange.min.toISOString().slice(0, 10), to: analytics.dateRange.max.toISOString().slice(0, 10) },
    },
  });
});

export default router;
