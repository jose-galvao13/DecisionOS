import React from "react";
import { C, chartTooltip, barCursor } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK } from "../../lib/format";
import { Card, KPI, SectionTitle, SourceBadge } from "../../components/ui";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

function BusinessIntelligence({ analytics, sourceInfo }) {
  const { t, locale } = useLang();
  const { totals, byRegion, monthly } = analytics;
  return (
    <div>
      <SectionTitle eyebrow="What is happening?" title="Business Intelligence" desc={t("bi.desc")} />
      <SourceBadge sourceInfo={sourceInfo} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <KPI label={t("kpi.revenue")} value={fmtK(totals.revenue, locale)} />
        <KPI label={t("kpi.transactions")} value={analytics.count.toLocaleString(locale)} />
        <KPI label={t("kpi.avgMargin")} value={`${totals.margin.toFixed(1)}%`} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("chart.revByRegion")}</div>
          <ResponsiveContainer width="100%" height={230}>
            <BarChart data={byRegion} layout="vertical" margin={{ left: 10 }}>
              <CartesianGrid stroke={C.greyBorderSoft} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 12, fill: C.textMuted }} axisLine={false} tickLine={false} tickFormatter={(v) => `${Math.round(v / 1000)}K`} />
              <YAxis type="category" dataKey="region" tick={{ fontSize: 12, fill: C.textSecondary }} axisLine={false} tickLine={false} width={80} />
              <Tooltip {...chartTooltip} cursor={barCursor} formatter={(v) => fmtK(v, locale)} />
              <Bar dataKey="value" radius={[0, 6, 6, 0]} fill={C.blue} />
            </BarChart>
          </ResponsiveContainer>
        </Card>
        <Card className="p-5">
          <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("chart.monthlyRevenue")}</div>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={monthly}>
              <CartesianGrid stroke={C.greyBorderSoft} vertical={false} />
              <XAxis dataKey="m" tick={{ fontSize: 12, fill: C.textMuted }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fontSize: 12, fill: C.textMuted }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => `${Math.round(v / 1000)}K`} />
              <Tooltip {...chartTooltip} formatter={(v) => fmtK(v, locale)} />
              <Line type="monotone" dataKey="revenue" stroke={C.blue} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>
    </div>
  );
}


export default BusinessIntelligence;
