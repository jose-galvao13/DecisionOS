import { fmtK } from "./format";

const RISK_TYPES = ["revenue_decline", "margin_deterioration", "customer_risk", "product_profitability", "cost_leakage", "sales_anomaly", "forecast_deviation"];

function formatImpact(impact, locale) {
  if (!impact || typeof impact.value !== "number") return null;
  if (!impact.currency || impact.currency === "EUR") return fmtK(impact.value, locale);
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: impact.currency, notation: "compact", maximumFractionDigits: 1 }).format(impact.value);
  } catch {
    return `${Math.round(impact.value).toLocaleString(locale)} ${impact.currency}`;
  }
}

/** The backend sends a `kind` and raw values, never a sentence — so the text
 *  follows the language switch (same approach as the data-quality issues). */
export function describeNotification(n, t, locale) {
  const p = n.params || {};
  switch (n.kind) {
    case "approval_pending":
      return { title: t("notif.approval_pending.title"), body: p.by ? t("notif.approval_pending.bodyBy", { title: p.title, by: p.by }) : t("notif.approval_pending.body", { title: p.title }) };
    case "decision_approved":
      return { title: t("notif.decision_approved.title"), body: t("notif.decision_approved.body", { title: p.title }) };
    case "decision_rejected":
      return { title: t("notif.decision_rejected.title"), body: p.reason ? t("notif.decision_rejected.bodyReason", { title: p.title, reason: p.reason }) : t("notif.decision_rejected.body", { title: p.title }) };
    case "outcome_measured":
      return { title: t("notif.outcome_measured.title"), body: t("notif.outcome_measured.body", { title: p.title }) };
    case "import_failed":
      return {
        title: p.name ? t("notif.import_failed.title", { name: p.name }) : t("notif.import_failed.titleNoName"),
        body: p.error || t("notif.import_failed.noDetail"), // the server's own error text, as-is
      };
    case "low_quality":
      return { title: t("notif.low_quality.title"), body: t("notif.low_quality.body", { name: p.name, score: p.score }) };
    case "risk": {
      const impact = formatImpact(p.impact, locale);
      return {
        title: t(`notif.risk.${RISK_TYPES.includes(p.type) ? p.type : "default"}`),
        body: impact ? t("notif.risk.bodyImpact", { impact }) : t("notif.risk.body"),
      };
    }
    default:
      return { title: n.kind, body: "" };
  }
}
