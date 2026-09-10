import React from "react";
import { Database, FileSpreadsheet, RefreshCw, ShieldCheck } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { pct } from "../../lib/format";
import { Card, SectionTitle, JobProgress } from "../../components/ui";

function DataPage({ analytics, sourceInfo, quality, onReplace, replaceJob }) {
  const { t } = useLang();
  return (
    <div>
      <SectionTitle title={t("data.title")} desc={t("data.desc")} />
      <Card className="p-6 mb-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: C.blueSoft }}>
              {sourceInfo.type === "excel" ? <FileSpreadsheet size={18} color={C.blue} /> : <Database size={18} color={C.blue} />}
            </div>
            <div>
              <div className="font-semibold" style={{ color: C.charcoal }}>{sourceInfo.type === "excel" ? sourceInfo.name : t("data.demoName")}</div>
              <div className="text-sm flex items-center gap-1.5 mt-0.5" style={{ color: C.textSecondary }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.green }} /> {t("data.connectedRows", { n: sourceInfo.rows })}
              </div>
            </div>
          </div>
          <button onClick={onReplace} disabled={!!replaceJob} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm disabled:opacity-50" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }}>
            <RefreshCw size={14} className={replaceJob ? "animate-spin" : ""} /> {t("data.replaceFile")}
          </button>
        </div>
        {/* FASE 8 progress indicator — replace-data is now an async job */}
        {replaceJob && (
          <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
            <JobProgress progress={replaceJob.progress} stage={replaceJob.stage} stageLabels={{
              queued: t("onboarding.stage.queued") || "Queued…",
              starting: t("onboarding.stage.starting") || "Starting…",
              validating: t("onboarding.stage.validating") || "Validating rows…",
              importing: t("onboarding.stage.importing") || "Importing rows…",
              analytics: t("onboarding.stage.analytics") || "Finishing up…",
            }} />
          </div>
        )}
      </Card>

      {quality && (
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck size={16} color={C.green} />
            <span className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("data.quality")}</span>
            <span className="tabnum ml-auto text-sm font-semibold" style={{ color: C.green }}>{t("data.healthy", { pct: quality.healthPct })}</span>
          </div>
          <div className="grid grid-cols-4 gap-3">
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.missingPct}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.missing")}</div></div>
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.duplicates}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.duplicates")}</div></div>
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.invalidIds}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.invalidIds")}</div></div>
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.inconsistent}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.inconsistent")}</div></div>
          </div>
        </Card>
      )}
    </div>
  );
}


export default DataPage;
