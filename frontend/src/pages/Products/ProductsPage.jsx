import React from "react";
import { Target } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK, pct } from "../../lib/format";
import { Card, SectionTitle, SourceBadge } from "../../components/ui";

export default function ProductsPage({ analytics, sourceInfo }) {
  const { t, locale } = useLang();
  const byProduct = analytics?.byProduct || [];
  const totalRevenue = byProduct.reduce((a, p) => a + p.revenue, 0) || 1;

  return (
    <div>
      <SectionTitle eyebrow={t("nav.products") || "Products"} title={t("nav.products")} desc="" />
      <SourceBadge sourceInfo={sourceInfo} />

      <Card className="p-0 mt-4 overflow-hidden">
        <div className="grid grid-cols-5 gap-2 px-4 py-2 text-xs font-semibold" style={{ background: C.greyBg, color: C.textSecondary }}>
          <div>{t("dim.product") || "Product"}</div>
          <div className="text-right">{t("kpi.revenue") || "Revenue"}</div>
          <div className="text-right">{t("kpi.profit") || "Profit"}</div>
          <div className="text-right">{t("kpi.margin") || "Margin"}</div>
          <div className="text-right">{t("products.shareOfRevenue") || "Share of revenue"}</div>
        </div>
        {byProduct.map((p, i) => {
          const margin = p.revenue ? (p.profit / p.revenue) * 100 : 0;
          return (
            <div key={i} className="grid grid-cols-5 gap-2 px-4 py-2.5 text-sm items-center" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
              <div className="flex items-center gap-2" style={{ color: C.charcoal }}>
                <Target size={13} color={C.blue} /> {p.product}
              </div>
              <div className="text-right tabnum" style={{ color: C.charcoal }}>{fmtK(p.revenue, locale)}</div>
              <div className="text-right tabnum" style={{ color: C.charcoal }}>{fmtK(p.profit, locale)}</div>
              <div className="text-right tabnum" style={{ color: margin < 15 ? C.red : C.green }}>{pct(margin)}</div>
              <div className="text-right tabnum" style={{ color: C.textMuted }}>{((p.revenue / totalRevenue) * 100).toFixed(1)}%</div>
            </div>
          );
        })}
        {!byProduct.length && <div className="px-4 py-6 text-sm" style={{ color: C.textMuted }}>{t("common.noData") || "No product data yet."}</div>}
      </Card>
    </div>
  );
}
