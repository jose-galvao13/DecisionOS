// Builds the compact JSON "digest" of current analytics + filters that
// gets sent to the backend AI Advisor / Chat tool-calling loop.

/* ---------------------------------------------------------------
   CLAUDE API — real calls, grounded in the unified data model
----------------------------------------------------------------*/
function buildDigest(analytics, filters) {
  if (!analytics) return null;
  return {
    activeFilters: filters ? {
      period: filters.period || "all",
      product: filters.product && filters.product !== "all" ? filters.product : null,
      region: filters.region && filters.region !== "all" ? filters.region : null,
      channel: filters.channel && filters.channel !== "all" ? filters.channel : null,
    } : null,
    profitBridge: analytics.profitBridge ? {
      totalChange: Math.round(analytics.profitBridge.totalChange),
      volumeEffect: Math.round(analytics.profitBridge.volumeEffect),
      priceEffect: Math.round(analytics.profitBridge.priceEffect),
      discountEffect: Math.round(analytics.profitBridge.discountEffect),
      costEffect: Math.round(analytics.profitBridge.costEffect),
      mixEffect: Math.round(analytics.profitBridge.mixEffect),
    } : null,
    customerIntelligence: analytics.customerIntelligence ? {
      totalCustomers: analytics.customerIntelligence.total,
      concentrationTop10PctOfRevenue: Number(analytics.customerIntelligence.concentrationPct.toFixed(1)),
      counts: analytics.customerIntelligence.counts,
    } : null,
    forecast: analytics.forecast ? {
      confidence: analytics.forecast.confidence,
      monthlyRevenueGrowthPct: Number(analytics.forecast.monthlyRevGrowthPct.toFixed(1)),
      nextMonths: analytics.forecast.months.map((m) => ({ monthsAhead: m.h, revenueBase: Math.round(m.revenue.base), profitBase: Math.round(m.profit.base) })),
    } : null,
    period: {
      from: analytics.dateRange.min.toISOString().slice(0, 10),
      to: analytics.dateRange.max.toISOString().slice(0, 10),
    },
    totals: {
      revenue: Math.round(analytics.totals.revenue),
      cost: Math.round(analytics.totals.cost),
      profit: Math.round(analytics.totals.profit),
      marginPct: Number(analytics.totals.margin.toFixed(1)),
    },
    trend_vs_prior_period: {
      revenuePctChange: Number(analytics.deltas.revenue.toFixed(1)),
      profitPctChange: Number(analytics.deltas.profit.toFixed(1)),
      marginChangePP: Number(analytics.deltas.marginPP.toFixed(1)),
    },
    monthly: analytics.monthly.map((m) => ({ month: m.key, revenue: Math.round(m.revenue), profit: Math.round(m.profit) })),
    topRegionsByRevenue: analytics.byRegion.slice(0, 5),
    productPerformance: analytics.byProduct.map((p) => ({ product: p.product, revenue: Math.round(p.revenue), marginPct: Number(p.margin.toFixed(1)) })),
    profitLeakage: analytics.leakage.map((l) => ({ dimension: l.dim, name: l.name, marginChangePP: Number(l.deltaPP.toFixed(1)), estimatedImpact: Math.round(l.impact) })),
    customerChurnRatePct: Number(analytics.churnRate.toFixed(1)),
    rowCount: analytics.count,
  };
}


export { buildDigest };
