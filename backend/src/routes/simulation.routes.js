import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { computeAnalyticsForOrg } from "../services/analyticsEngine.js";
import {
  simulatePriceChange,
  simulateCostChange,
  simulateChurnChange,
  simulateVolumeChange,
  simulateDiscontinueProduct,
  simulateLevers,
} from "../services/simulationEngine.js";

const router = Router();
router.use(requireAuth);

const HANDLERS = {
  price: (analytics, params) => simulatePriceChange(analytics, Number(params.percentChange) || 0),
  cost: (analytics, params) => simulateCostChange(analytics, Number(params.percentChange) || 0),
  churn: (analytics, params) => simulateChurnChange(analytics, Number(params.percentChange) || 0),
  volume: (analytics, params) => simulateVolumeChange(analytics, Number(params.percentChange) || 0),
  discontinue_product: (analytics, params) => simulateDiscontinueProduct(analytics, params.product),
  // Combined multi-lever run — what the Decision Simulator page's three
  // sliders (price/marketing/churn moving together) actually need. See
  // simulateLevers()'s own header for why this replaced a frontend-local
  // reimplementation that included a fabricated "90% CI".
  levers: (analytics, params) => simulateLevers(analytics, {
    pricePct: Number(params.pricePct) || 0,
    marketingPct: Number(params.marketingPct) || 0,
    churnPct: Number(params.churnPct) || 0,
  }),
};

/**
 * POST /api/simulate
 * Body: { type: 'price'|'cost'|'churn'|'volume'|'discontinue_product'|'levers',
 *          percentChange?: number, product?: string,
 *          pricePct?/marketingPct?/churnPct? (type: 'levers' only), filters?: object }
 *
 * Runs a what-if scenario against this org's own analytics (same source
 * /api/analytics and the AI Advisor use — a scenario run here and one run
 * through simulate_price_change etc. in the Advisor use identical math).
 */
router.post("/", async (req, res) => {
  const { type, percentChange, product, pricePct, marketingPct, churnPct, filters } = req.body || {};
  const handler = HANDLERS[type];
  if (!handler) {
    return res.status(400).json({ error: `type must be one of: ${Object.keys(HANDLERS).join(", ")}` });
  }
  if (type === "discontinue_product" && !product) {
    return res.status(400).json({ error: "product is required for type 'discontinue_product'" });
  }

  const analytics = await computeAnalyticsForOrg(req.user.orgId, filters || {});
  if (!analytics) {
    return res.status(404).json({ error: "no transactions found for this organization yet — connect or upload a data source first" });
  }

  const result = handler(analytics, { percentChange, product, pricePct, marketingPct, churnPct });
  if (result?.error) return res.status(400).json(result);
  res.json(result);
});

export default router;
