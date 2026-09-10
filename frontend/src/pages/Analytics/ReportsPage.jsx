import React from "react";
import { Printer, FileText } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { Card, SectionTitle, SourceBadge } from "../../components/ui";

// Filled in the previously-undefined `ReportsPage` nav target
// (case "reports" in the original monolith referenced a component
// that didn't exist). Keeps this deliberately light: a printable
// executive summary built from data already on `analytics`, not a
// new reporting subsystem.
export default function ReportsPage({ analytics, sourceInfo }) {
  const { t, locale } = useLang();

  const handlePrint = () => window.print();

  return (
    <div>
      <SectionTitle eyebrow={t("nav.reports") || "Reports"} title="Reports" desc="" />
      <SourceBadge sourceInfo={sourceInfo} />

      <Card className="p-6 mt-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileText size={16} color={C.blue} />
            <div className="text-sm font-semibold" style={{ color: C.charcoal }}>
              {t("reports.executiveSummary") || "Executive summary"}
            </div>
          </div>
          <button
            onClick={handlePrint}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm"
            style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }}
          >
            <Printer size={14} /> {t("reports.print") || "Print / export PDF"}
          </button>
        </div>

        {!analytics && (
          <div className="text-sm" style={{ color: C.textMuted }}>
            {t("common.noData") || "No data connected yet."}
          </div>
        )}

        {analytics && (
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs" style={{ color: C.textMuted }}>{t("kpi.revenue") || "Revenue"}</div>
              <div className="tabnum text-lg font-semibold">{analytics.totals?.revenue?.toLocaleString(locale)}</div>
            </div>
            <div>
              <div className="text-xs" style={{ color: C.textMuted }}>{t("kpi.profit") || "Profit"}</div>
              <div className="tabnum text-lg font-semibold">{analytics.totals?.profit?.toLocaleString(locale)}</div>
            </div>
            <div>
              <div className="text-xs" style={{ color: C.textMuted }}>{t("kpi.margin") || "Margin"}</div>
              <div className="tabnum text-lg font-semibold">{analytics.totals?.margin?.toFixed(1)}%</div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
