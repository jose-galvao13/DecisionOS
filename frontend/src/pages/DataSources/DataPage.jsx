import React from "react";
import { Database, FileSpreadsheet, Plus, ShieldCheck, Trash2, Check, Loader2 } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { Card, SectionTitle, JobProgress } from "../../components/ui";

/* ---------------------------------------------------------------
   DATA PAGE — every file / source the organization has uploaded.
   Only one is "active" at a time: that one feeds the dashboards, the
   analytics, the AI advisor and the reports (backend:
   services/activeSource.js). Here you can keep several, switch which
   one is active, add another file, or remove one.
----------------------------------------------------------------*/

function statusOf(source, t, locale) {
  const date = source.last_sync_at ? new Date(source.last_sync_at) : null;
  const when = date && !Number.isNaN(date.getTime()) ? ` · ${t("data.updatedOn", { date: date.toLocaleDateString(locale) })}` : "";
  if (source.status === "syncing") return { color: C.yellow, text: t("data.status.syncing") };
  if (source.status === "error") return { color: C.red, text: t("data.status.error") };
  return { color: C.green, text: t("data.connectedRows", { n: source.row_count ?? 0 }) + when };
}

function SourceRow({ source, active, busy, canManage, onActivate, onRemove }) {
  const { t, locale } = useLang();
  const status = statusOf(source, t, locale);
  const usable = source.status === "connected" && Number(source.row_count) > 0;
  const Icon = source.type === "excel" ? FileSpreadsheet : Database;

  return (
    <div
      data-testid="source-row"
      className="flex items-center justify-between gap-3 p-4 rounded-xl"
      style={{ border: `1px solid ${active ? C.blue : C.greyBorder}`, background: active ? C.blueSoft : "transparent" }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: active ? C.surface : C.blueSoft }}>
          <Icon size={18} color={C.blue} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate" style={{ color: C.charcoal }}>{source.name}</span>
            {active && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0" style={{ background: C.blue, color: C.white }}>
                {t("data.active")}
              </span>
            )}
          </div>
          <div className="text-sm flex items-center gap-1.5 mt-0.5" style={{ color: C.textSecondary }}>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: status.color }} /> {status.text}
          </div>
        </div>
      </div>

      {canManage && (
        <div className="flex items-center gap-2 shrink-0">
          {!active && usable && (
            <button
              onClick={() => onActivate(source)}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              style={{ background: C.blue, color: C.white }}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t("data.useFile")}
            </button>
          )}
          <button
            onClick={() => onRemove(source)}
            disabled={busy}
            title={t("data.remove")}
            aria-label={`${t("data.remove")} ${source.name}`}
            className="p-2 rounded-lg disabled:opacity-50"
            style={{ border: `1px solid ${C.greyBorder}`, color: C.textSecondary }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function DataPage({ analytics, sourceInfo, quality, onAdd, replaceJob, sources = [], activeId, onActivate, onRemove, busyId, canManage = true }) {
  const { t } = useLang();

  // If the list hasn't loaded (or the backend is older than the list feature)
  // still show the file that is in use, so the page is never empty.
  const rows = sources.length
    ? sources
    : sourceInfo.type !== "demo"
    ? [{ id: sourceInfo.dataSourceId ?? "current", name: sourceInfo.name, type: sourceInfo.type, status: "connected", row_count: sourceInfo.rows, last_sync_at: sourceInfo.lastUpdated }]
    : [];
  const currentId = activeId ?? sourceInfo.dataSourceId;

  return (
    <div>
      <SectionTitle title={t("data.title")} desc={t("data.desc")} />
      <Card className="p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-1">
          <div>
            <div className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("data.filesTitle")}</div>
            <p className="text-sm mt-1 max-w-2xl" style={{ color: C.textSecondary }}>{t("data.filesHint")}</p>
          </div>
          {canManage && (
            <button
              onClick={onAdd}
              disabled={!!replaceJob}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium shrink-0 disabled:opacity-50"
              style={{ background: C.blue, color: C.white }}
            >
              {replaceJob ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t("data.addFile")}
            </button>
          )}
        </div>

        <div className="mt-4 space-y-3">
          {rows.length === 0 && (
            // demo mode: nothing uploaded yet
            <div className="flex items-center gap-3 p-4 rounded-xl" style={{ border: `1px solid ${C.greyBorder}` }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: C.blueSoft }}>
                <Database size={18} color={C.blue} />
              </div>
              <div>
                <div className="font-semibold" style={{ color: C.charcoal }}>{t("data.demoName")}</div>
                <div className="text-sm flex items-center gap-1.5 mt-0.5" style={{ color: C.textSecondary }}>
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.green }} /> {t("data.connectedRows", { n: sourceInfo.rows })}
                </div>
              </div>
            </div>
          )}
          {rows.map((s) => (
            <SourceRow
              key={s.id}
              source={s}
              active={s.id === currentId}
              busy={busyId === s.id}
              canManage={canManage && sources.length > 0}
              onActivate={onActivate}
              onRemove={onRemove}
            />
          ))}
        </div>

        {/* FASE 8 progress indicator — importing a file is an async job */}
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
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.missingPct ?? "—"}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.missing")}</div></div>
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.duplicates ?? "—"}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.duplicates")}</div></div>
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.invalidIds ?? "—"}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.invalidIds")}</div></div>
            <div className="p-3 rounded-xl" style={{ background: C.greyBg }}><div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{quality.inconsistent ?? "—"}</div><div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("quality.inconsistent")}</div></div>
          </div>
        </Card>
      )}
    </div>
  );
}


export default DataPage;
