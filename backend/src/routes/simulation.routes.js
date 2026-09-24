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
  simulateSellPosition,
} from "../services/simulationEngine.js";
import { loadPortfolioContext } from "../services/portfolioData.js";

const router = Router();
router.use(requireAuth);

// Handlers receive (analytics, params, ctx). `analytics` is the org's sales
// analytics; `ctx.portfolio` is only loaded for the PORTFOLIO_TYPES below.
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
  // Parte 2, FASE 4 — stock portfolio what-if. Works on the portfolio's own
  // data (holdings + price history), not on the sales analytics, so it is
  // listed in PORTFOLIO_TYPES below and never needs transactions to exist.
  sell_position: (_analytics, params, ctx) => simulateSellPosition({
    ticker: params.ticker,
    percent: Number(params.percent),
    portfolio: ctx.portfolio.analytics,
    seriesByTicker: ctx.portfolio.seriesByTicker,
  }),
};

// Types that read the stock portfolio instead of the sales analytics.
const PORTFOLIO_TYPES = new Set(["sell_position"]);

/**
 * POST /api/simulate
 * Body: { type: 'price'|'cost'|'churn'|'volume'|'discontinue_product'|'levers'|'sell_position',
 *          percentChange?: number, product?: string,
 *          pricePct?/marketingPct?/churnPct? (type: 'levers' only),
 *          ticker?/percent? (type: 'sell_position' only), filters?: object }
 *
 * Runs a what-if scenario against this org's own analytics (same source
 * /api/analytics and the AI Advisor use — a scenario run here and one run
 * through simulate_price_change etc. in the Advisor use identical math).
 */
router.post("/", async (req, res) => {
  const { type, percentChange, product, pricePct, marketingPct, churnPct, ticker, percent, filters } = req.body || {};
  const handler = HANDLERS[type];
  if (!handler) {
    return res.status(400).json({ error: `type must be one of: ${Object.keys(HANDLERS).join(", ")}` });
  }
  if (type === "discontinue_product" && !product) {
    return res.status(400).json({ error: "product is required for type 'discontinue_product'" });
  }

  if (PORTFOLIO_TYPES.has(type)) {
    if (!ticker) return res.status(400).json({ error: "ticker is required for type 'sell_position'" });
    const portfolio = await loadPortfolioContext(req.user.orgId);
    if (!portfolio.analytics.positions.length) {
      return res.status(404).json({ error: "no portfolio positions found for this organization yet — import a holdings file first" });
    }
    const result = handler(null, { ticker, percent }, { portfolio });
    if (result?.error) return res.status(400).json(result);
    return res.json(result);
  }

  const analytics = await computeAnalyticsForOrg(req.user.orgId, filters || {});
  if (!analytics) {
    return res.status(404).json({ error: "no transactions found for this organization yet — connect or upload a data source first" });
  }

  const result = handler(analytics, { percentChange, product, pricePct, marketingPct, churnPct }, {});
  if (result?.error) return res.status(400).json(result);
  res.json(result);
});

export default router;
