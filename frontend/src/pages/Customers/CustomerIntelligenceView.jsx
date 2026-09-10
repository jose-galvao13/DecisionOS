import React from "react";
import { Users, TrendingDown, TrendingUp } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK, pct } from "../../lib/format";
import { Card, KPI, SectionTitle, SourceBadge } from "../../components/ui";

// NOTE: in the original monolith this component was referenced in the
// nav switch (`case "customers"`) but never defined, so clicking
// "Customer Intelligence" threw a ReferenceError at runtime. This is
// the real implementation, built on `analytics.customerIntelligence`
// (see lib/metrics.js -> computeCustomerIntelligence).
function SegmentTable({ title, tone, rows, locale }) {
  const toneColor = tone === "red" ? C.red : tone === "green" ? C.green : C.textSecondary;
  return (
    <Card className="p-4">
      <div className="text-sm font-semibold mb-3" style={{ color: toneColor }}>{title} ({rows.length})</div>
      {rows.length === 0 && <div className="text-xs" style={{ color: C.textMuted }}>—</div>}
      {rows.map((c, i) => (
        <div key={i} className="flex items-center justify-between py-1.5 text-sm" style={{ borderTop: i ? `1px solid ${C.greyBorderSoft}` : "none" }}>
          <span style={{ color: C.charcoal }}>{c.customer}</span>
          <span className="tabnum" style={{ color: C.textSecondary }}>{fmtK(c.revenue, locale)}</span>
        </div>
      ))}
    </Card>
  );
}

export default function CustomerIntelligenceView({ analytics, sourceInfo }) {
  const { t, locale } = useLang();
  const ci = analytics?.customerIntelligence;

  if (!ci) {
    return (
      <div>
        <SectionTitle eyebrow={t("nav.customers")} title="Customer Intelligence" desc="" />
        <SourceBadge sourceInfo={sourceInfo} />
        <Card className="p-6 text-sm" style={{ color: C.textMuted }}>
          {t("customers.noData") || "Not enough customer data to compute intelligence yet."}
        </Card>
      </div>
    );
  }

  return (
    <div>
      <SectionTitle eyebrow={t("nav.customers")} title="Customer Intelligence" desc="" />
      <SourceBadge sourceInfo={sourceInfo} />

      <div className="grid grid-cols-4 gap-4 my-5">
        <KPI label={t("customers.total") || "Total customers"} value={ci.total} />
        <KPI label={t("customers.concentration") || "Top 10% revenue share"} value={pct(ci.concentrationPct)} />
        <KPI label={t("customers.atRisk") || "At risk"} value={ci.counts.atRisk} deltaTone={ci.counts.atRisk > 0 ? "red" : "green"} />
        <KPI label={t("customers.growing") || "Growing"} value={ci.counts.growing} deltaTone="green" />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <SegmentTable title={t("customers.atRisk") || "At risk"} tone="red" rows={ci.segments.atRisk} locale={locale} />
        <SegmentTable title={t("customers.declining") || "Declining"} tone="neutral" rows={ci.segments.declining} locale={locale} />
        <SegmentTable title={t("customers.growing") || "Growing"} tone="green" rows={ci.segments.growing} locale={locale} />
      </div>

      <div className="grid grid-cols-2 gap-4 mt-4">
        <SegmentTable title={t("customers.new") || "New"} tone="green" rows={ci.segments.new} locale={locale} />
        <SegmentTable title={t("customers.churned") || "Churned"} tone="red" rows={ci.segments.churned} locale={locale} />
      </div>
    </div>
  );
}
