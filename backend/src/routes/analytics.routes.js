import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { computeAnalyticsForOrg } from "../services/analyticsEngine.js";

const router = Router();
router.use(requireAuth);

function filtersFromQuery(q) {
  return { period: q.period, product: q.product, region: q.region, channel: q.channel };
}

/**
 * FASE 2: this is now the real analytics engine (ported from
 * DecisionOS.jsx's computeAnalytics), reading from this org's own data in
 * Postgres — not a client-computed snapshot. Optional query params: period
 * (all|30D|QTD|YTD), product, region, channel — same filter semantics as
 * the frontend's filter bar.
 *
 * This is also exactly what /api/advisor now calls server-side (see
 * server.js), so the AI advisor and this endpoint are always looking at
 * the same numbers.
 */
router.get("/full", async (req, res) => {
  const analytics = await computeAnalyticsForOrg(req.user.orgId, filtersFromQuery(req.query));
  if (!analytics) return res.status(404).json({ error: "no transactions found for this organization yet — connect or upload a data source first" });
  res.json(analytics);
});

router.get("/overview", async (req, res) => {
  const analytics = await computeAnalyticsForOrg(req.user.orgId, filtersFromQuery(req.query));
  if (!analytics) return res.json({ revenue: 0, profit: 0, marginPct: 0, transactions: 0, period: null });
  res.json({
    revenue: Math.round(analytics.totals.revenue),
    profit: Math.round(analytics.totals.profit),
    marginPct: Number(analytics.totals.margin.toFixed(1)),
    transactions: analytics.count,
    period: { from: analytics.dateRange.min.toISOString().slice(0, 10), to: analytics.dateRange.max.toISOString().slice(0, 10) },
  });
});

router.get("/revenue/monthly", async (req, res) => {
  const analytics = await computeAnalyticsForOrg(req.user.orgId, filtersFromQuery(req.query));
  if (!analytics) return res.json({ monthly: [] });
  res.json({ monthly: analytics.monthly.map((m) => ({ month: m.key, revenue: Math.round(m.revenue), profit: Math.round(m.profit) })) });
});

export default router;
