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
