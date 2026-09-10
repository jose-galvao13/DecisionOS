import React from "react";
import { AlertTriangle, TrendingUp } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK, fmtSigned } from "../../lib/format";
import { Card, KPI, Pill, SectionTitle, SourceBadge } from "../../components/ui";

function ProfitBridgeCard({ bridge, locale }) {
  const { t } = useLang();
  if (!bridge) return null;
  const rows = [
    { key: "volumeEffect", label: t("bridge.volume") },
    { key: "priceEffect", label: t("bridge.price") },
    { key: "discountEffect", label: t("bridge.discount") },
    { key: "costEffect", label: t("bridge.cost") },
    { key: "mixEffect", label: t("bridge.mix") },
  ];
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(bridge[r.key])));
  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-1"><TrendingUp size={16} color={C.blue} /><span className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("bridge.title")}</span></div>
      <p className="text-xs mb-4" style={{ color: C.textMuted }}>{t("bridge.desc")}</p>
      <div className="flex items-center justify-between mb-3 text-sm">
        <span style={{ color: C.textSecondary }}>{t("bridge.start")}: <span className="tabnum font-medium" style={{ color: C.charcoal }}>{fmtK(bridge.profit1, locale)}</span></span>
        <span style={{ color: C.textSecondary }}>{t("bridge.end")}: <span className="tabnum font-medium" style={{ color: C.charcoal }}>{fmtK(bridge.profit2, locale)}</span></span>
      </div>
      <div className="space-y-2.5">
        {rows.map((r) => {
          const v = bridge[r.key];
          const pos = v >= 0;
          const widthPct = Math.min(100, (Math.abs(v) / maxAbs) * 100);
          return (
            <div key={r.key} className="flex items-center gap-3">
              <div className="w-20 text-xs shrink-0" style={{ color: C.textSecondary }}>{r.label}</div>
              <div className="flex-1 h-5 rounded-md relative" style={{ background: C.greyBg }}>
                <div className="h-5 rounded-md" style={{ width: `${widthPct}%`, background: pos ? C.green : C.red }} />
              </div>
              <div className="tabnum text-sm font-semibold w-20 text-right shrink-0" style={{ color: pos ? C.green : C.red }}>{fmtSigned(v, "€", locale)}</div>
            </div>
          );
        })}
      </div>
      <p className="text-xs mt-4" style={{ color: C.textMuted }}>{t("bridge.mixNote")}</p>
    </Card>
  );
}

function ProfitIntelligence({ analytics, sourceInfo }) {
  const { t, locale } = useLang();
  const { totals, leakage, churnRate } = analytics;
  const dimLabel = (d) => (d === "Produto" ? t("dim.product") : d === "Região" ? t("dim.region") : d === "Canal" ? t("dim.channel") : d);
  return (
    <div>
      <SectionTitle eyebrow="Where am I losing money?" title="Profit Intelligence" desc={t("profit.desc")} />
      <SourceBadge sourceInfo={sourceInfo} />
      <div className="grid grid-cols-4 gap-4 mb-6">
        <KPI label={t("kpi.grossProfit")} value={fmtK(totals.profit, locale)} />
        <KPI label={t("kpi.margin")} value={`${totals.margin.toFixed(1)}%`} />
        <KPI label={t("kpi.churnRate")} value={`${churnRate.toFixed(1)}%`} sub={t("kpi.churnSub")} />
        <KPI label={t("kpi.leaksFound")} value={leakage.length} />
      </div>
      <div className="grid grid-cols-2 gap-4 mb-4 items-start">
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4"><AlertTriangle size={16} color={C.red} /><span className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("profit.leakageTitle")}</span></div>
          <div className="space-y-3">
            {leakage.map((l) => (
              <div key={l.name} className="flex items-center justify-between p-4 rounded-xl" style={{ background: C.greyBg }}>
                <div>
                  <div className="font-medium" style={{ color: C.charcoal }}>{l.name}</div>
                  <div className="text-sm mt-0.5" style={{ color: C.textSecondary }}>{t("profit.leakageLine", { pp: l.deltaPP.toFixed(1) })}</div>
                </div>
                <div className="flex items-center gap-3">
                  <Pill tone="red">{dimLabel(l.dim)}</Pill>
                  <div className="tabnum text-lg font-semibold w-24 text-right" style={{ color: C.red }}>{fmtK(l.impact, locale)}</div>
                </div>
              </div>
            ))}
            {!leakage.length && <div className="text-sm" style={{ color: C.textMuted }}>{t("profit.noLeakage")}</div>}
          </div>
        </Card>
        <ProfitBridgeCard bridge={analytics.profitBridge} locale={locale} />
      </div>
    </div>
  );
}


/* Pure DCF calculator — extracted so it can run once for the base case and
   again, cheaply, across a WACC × terminal-growth grid for the sensitivity matrix. */

export default ProfitIntelligence;
export { ProfitBridgeCard };
