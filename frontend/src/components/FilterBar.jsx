import React from "react";
import { C } from "../lib/theme";
import { useLang } from "../lib/i18n";

/* ---------------------------------------------------------------
   VIEWS
----------------------------------------------------------------*/
function FilterBar({ analytics, filters, onChange }) {
  const { t } = useLang();
  const opts = [{ id: "all", label: t("filter.all") }, { id: "30D", label: "30D" }, { id: "QTD", label: "QTD" }, { id: "YTD", label: "YTD" }];
  // Options come from the already-computed analytics (works the same whether
  // `analytics` was computed locally from demo transactions or fetched from
  // the backend — both shapes carry byProduct/byRegion/byChannel).
  const uniq = (key) => {
    if (!analytics) return [];
    const source = key === "product" ? analytics.byProduct.map((p) => p.product)
      : key === "region" ? analytics.byRegion.map((r) => r.region)
      : analytics.byChannel.map((c) => c.channel);
    return [...new Set(source.filter(Boolean))].sort();
  };
  const Dim = ({ dimKey, label }) => (
    <select
      value={filters[dimKey] || "all"}
      onChange={(e) => onChange({ [dimKey]: e.target.value })}
      className="text-sm px-2.5 py-1.5 rounded-lg outline-none"
      style={{ border: `1px solid ${C.greyBorder}`, color: filters[dimKey] && filters[dimKey] !== "all" ? C.blue : C.textSecondary, background: C.surface }}
    >
      <option value="all">{label}: {t("filter.all")}</option>
      {uniq(dimKey).map((v) => <option key={v} value={v}>{v}</option>)}
    </select>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 mb-5">
      <div className="flex rounded-xl p-1" style={{ background: C.greyBg }}>
        {opts.map((o) => (
          <button key={o.id} onClick={() => onChange({ period: o.id })} className="px-3 py-1.5 text-sm rounded-lg transition-colors"
            style={filters.period === o.id ? { background: C.surface, color: C.charcoal, fontWeight: 600, boxShadow: "0 1px 2px rgba(10,21,38,0.08)" } : { color: C.textSecondary }}>
            {o.label}
          </button>
        ))}
      </div>
      <Dim dimKey="product" label={t("dim.product")} />
      <Dim dimKey="region" label={t("dim.region")} />
      <Dim dimKey="channel" label={t("dim.channel")} />
      <span className="text-xs" style={{ color: C.textMuted }}>{t("filter.note")}</span>
    </div>
  );
}


export default FilterBar;
