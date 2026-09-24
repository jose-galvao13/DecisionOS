import { fmtK } from "./format";

/** Turns a deterministic alert (see computeAlerts in metrics.js) into
 *  translated { title, line } copy. Copy always describes magnitudes (the title/verb carries the direction, so
 *  no "fell -11pp" double negatives). Shared by the Overview decision feed
 *  and the Reports page so both always word an alert identically. */
export function alertCopy(a, t, locale) {
  switch (a.type) {
    case "margin": return { title: t("alerts.margin"), line: t("alerts.marginLine", { name: a.name, pp: Math.abs(a.pp).toFixed(1) }) };
    case "churn": return { title: t("alerts.churn"), line: t("alerts.churnLine", { rate: a.rate.toFixed(1) }) };
    case "growth": return { title: t("alerts.growth"), line: t("alerts.growthLine", { region: a.region, growth: a.growth.toFixed(1), margin: a.margin.toFixed(1) }) };
    case "cost": return { title: t("alerts.cost"), line: t("alerts.costLine", { impact: fmtK(Math.abs(a.impact), locale) }) };
    case "discount": return { title: t("alerts.discount"), line: t("alerts.discountLine", { impact: fmtK(Math.abs(a.impact), locale) }) };
    case "productDecline": return { title: t("alerts.productDecline"), line: t("alerts.productDeclineLine", { product: a.product, growth: Math.abs(a.growth).toFixed(1) }) };
    default: return { title: t("alerts.customerRisk"), line: t("alerts.customerRiskLine", { n: a.n }) };
  }
}

/** Copy for the portfolio concentration notification (backend kind
 *  "portfolio_concentration", see services/notifications.js — Parte 2,
 *  FASE 4). `p` is the notification's raw `params`: the ticker and weight of
 *  the largest position, the HHI, the effective number of positions and
 *  which of the two limits (position weight / HHI) was crossed. Same
 *  { title, line } shape as alertCopy(); notifications.js uses `line` as the
 *  notification body. It describes the concentration and where to look at
 *  it — never what to do about it. */
export function portfolioConcentrationCopy(p, t, locale = "pt-PT") {
  const num = (v, digits) => Number(v).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const reasons = p.reasons || [];
  const vars = { ticker: p.ticker, pct: num(p.pesoPct, 1), limit: num(p.maxPositionPct ?? 25, 0), hhi: num(p.hhi, 2), n: num(p.effectiveN, 1) };
  const key = reasons.includes("position") && reasons.includes("hhi") ? "Both" : reasons.includes("hhi") ? "Hhi" : "Position";
  return {
    title: t("alerts.portfolioConcentration"),
    line: `${t(`alerts.portfolioConcentration${key}`, vars)} ${t("alerts.portfolioConcentrationHint")}`,
  };
}
