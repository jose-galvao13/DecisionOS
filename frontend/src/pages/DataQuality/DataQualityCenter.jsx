import { normalizeQuality, describeIssue } from "../../lib/quality";
import React from "react";
import { CheckCircle2, AlertTriangle, ShieldCheck, Database, Clock, XCircle, Loader2 } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch } from "../../api/client";
import { Card, SectionTitle } from "../../components/ui";

/* ---------------------------------------------------------------
   DATA QUALITY CENTER — FASE 7. Previously "Data Quality" was a
   small block buried inside DataPage (Data Sources). This promotes
   it to a full page, built on the same `quality` object DataPage
   already receives (see lib/mapping.js -> computeDataQuality, or
   backend services/dataQuality.js -> assessQuality for connected
   sources).

   `quality` shape (frontend, from computeDataQuality):
     { healthPct, missingPct, duplicates, invalidIds, inconsistent, rows }
   Backend `assessQuality` returns { score, issues }; both are
   normalized here so this page works whichever produced it.
----------------------------------------------------------------*/


// Issues come with a red/yellow/green severity from the backend.
const SEVERITY_COLOR = { red: C.red, yellow: C.yellow, green: C.green };

function CheckRow({ ok, label, count }) {
  return (
    <div className="flex items-center justify-between py-2" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
      <div className="flex items-center gap-2">
        {ok ? <CheckCircle2 size={15} color={C.green} /> : <AlertTriangle size={15} color={C.yellow} />}
        <span className="text-sm" style={{ color: C.charcoal }}>{label}</span>
      </div>
      {typeof count === "number" && count > 0 && (
        <span className="text-xs tabnum" style={{ color: C.textMuted }}>{count}</span>
      )}
    </div>
  );
}

function SyncHistory({ dataSourceId }) {
  const { t, locale } = useLang();
  const [state, setState] = React.useState({ loading: true, jobs: [], error: "" });

  React.useEffect(() => {
    if (!dataSourceId) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: "" }));
    apiFetch(`/api/datasources/${dataSourceId}/jobs?limit=10`)
      .then((data) => { if (!cancelled) setState({ loading: false, jobs: data.jobs || [], error: "" }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, jobs: [], error: e.message }); });
    return () => { cancelled = true; };
  }, [dataSourceId]);

  if (!dataSourceId) {
    return <div className="text-sm" style={{ color: C.textMuted }}>{t("dq.syncHistoryNoSource") || "Connect a real data source (not demo data) to see sync jobs here."}</div>;
  }
  if (state.loading) {
    return <div className="flex items-center gap-2 text-sm" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> {t("dq.loading") || "Loading…"}</div>;
  }
  if (state.error) {
    return <div className="text-sm" style={{ color: C.red }}>{state.error}</div>;
  }
  if (!state.jobs.length) {
    return <div className="text-sm" style={{ color: C.textMuted }}>{t("dq.syncHistoryEmpty") || "No sync jobs yet — imports and refreshes will show up here."}</div>;
  }

  const STATUS_ICON = { completed: CheckCircle2, failed: XCircle, running: Loader2, queued: Clock };
  const STATUS_COLOR = { completed: C.green, failed: C.red, running: C.blue, queued: C.textMuted };

  return (
    <div className="space-y-1">
      {state.jobs.map((job) => {
        const Icon = STATUS_ICON[job.status] || Clock;
        const durationMs = job.finishedAt && job.startedAt ? new Date(job.finishedAt) - new Date(job.startedAt) : null;
        return (
          <div key={job.jobId} className="flex items-center justify-between py-2" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
            <div className="flex items-center gap-2">
              <Icon size={15} color={STATUS_COLOR[job.status]} className={job.status === "running" ? "animate-spin" : ""} />
              <span className="text-sm" style={{ color: C.charcoal }}>{job.type}</span>
              {job.status !== "completed" && job.status !== "failed" && (
                <span className="text-xs tabnum" style={{ color: C.textMuted }}>{job.progress}% · {job.stage}</span>
              )}
              {job.error && <span className="text-xs" style={{ color: C.red }}>{job.error}</span>}
            </div>
            <div className="flex items-center gap-3 text-xs tabnum" style={{ color: C.textMuted }}>
              {durationMs != null && <span>{Math.round(durationMs / 1000)}s</span>}
              <span>{new Date(job.createdAt).toLocaleString(locale)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function DataQualityCenter({ quality, sourceInfo, analytics }) {
  const { t, locale } = useLang();
  const q = normalizeQuality(quality);

  const [tab, setTab] = React.useState("issues");
  const tabs = [
    { id: "issues", label: t("dq.issues") || "Issues" },
    { id: "warnings", label: t("dq.warnings") || "Warnings" },
    { id: "mapping", label: t("dq.mapping") || "Mapping" },
    { id: "skipped", label: t("dq.skipped") || "Skipped rows" },
    { id: "syncHistory", label: t("dq.syncHistory") || "Sync history" },
    { id: "lineage", label: t("dq.lineage") || "Data lineage" },
  ];

  if (!q) {
    return (
      <div>
        <SectionTitle eyebrow={t("nav.dataQuality") || "Data Quality"} title={t("dq.title")} desc="" />
        <Card className="p-6 text-sm" style={{ color: C.textMuted }}>
          {t("dq.noData") || "Connect a data source to see its quality report."}
        </Card>
      </div>
    );
  }

  const scoreColor = q.healthPct >= 90 ? C.green : q.healthPct >= 70 ? C.yellow : C.red;

  return (
    <div>
      <SectionTitle eyebrow={t("nav.dataQuality") || "Data Quality"} title={t("dq.title")} desc="" />

      <div className="grid grid-cols-3 gap-4 mt-4">
        {/* Score card */}
        <Card className="p-5">
          <div className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: C.textSecondary }}>
            {t("dq.score") || "Score"}
          </div>
          <div className="text-4xl font-bold tabnum mb-4" style={{ color: scoreColor }}>
            {Math.round(q.healthPct)}%
          </div>
          <CheckRow ok={q.healthPct >= 90} label={t("dq.completeness") || "Completeness"} />
          <CheckRow ok={(q.inconsistent || 0) === 0} label={t("dq.validity") || "Validity"} count={q.invalidIds} />
          <CheckRow ok={(q.inconsistent || 0) === 0} label={t("dq.consistency") || "Consistency"} count={q.inconsistent} />
          {!!(q.anomalies) && <CheckRow ok={false} label={t("dq.anomalies") || "Anomalies"} count={q.anomalies} />}
          {!!(q.unmapped) && <CheckRow ok={false} label={t("dq.unmappedRows") || "Unmapped rows"} count={q.unmapped} />}
        </Card>

        {/* Sync / source card */}
        <Card className="p-5">
          <div className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: C.textSecondary }}>
            {t("dq.lastSync") || "Last sync"}
          </div>
          <div className="flex items-center gap-2 mb-4">
            <Clock size={15} color={C.blue} />
            <span className="text-sm" style={{ color: C.charcoal }}>
              {sourceInfo?.lastUpdated ? new Date(sourceInfo.lastUpdated).toLocaleString(locale) : (t("dq.never") || "—")}
            </span>
          </div>
          <div className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: C.textSecondary }}>
            {t("dq.source") || "Source"}
          </div>
          <div className="flex items-center gap-2">
            <Database size={15} color={C.blue} />
            <span className="text-sm" style={{ color: C.charcoal }}>{sourceInfo?.name || sourceInfo?.type || "—"}</span>
          </div>
        </Card>

        {/* Rows / duplicates card */}
        <Card className="p-5">
          <div className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: C.textSecondary }}>
            {t("dq.dataset") || "Dataset"}
          </div>
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck size={15} color={C.blue} />
            <span className="text-sm tabnum" style={{ color: C.charcoal }}>{q.rows ?? sourceInfo?.rows ?? "—"} {t("dq.rows") || "rows"}</span>
          </div>
          <div className="text-xs" style={{ color: C.textMuted }}>
            {t("dq.duplicates") || "Duplicates"}: {q.duplicates ?? 0}
          </div>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mt-6 mb-3 border-b" style={{ borderColor: C.greyBorderSoft }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className="px-3 py-2 text-sm"
            style={tab === tb.id
              ? { color: C.blue, borderBottom: `2px solid ${C.blue}`, fontWeight: 600 }
              : { color: C.textSecondary }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      <Card className="p-5">
        {tab === "issues" && (
          (q.issues || []).length
            ? q.issues.map((it, i) => (
              <div key={i} className="flex items-center gap-2 text-sm py-1" style={{ color: C.charcoal }}>
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: SEVERITY_COLOR[it.severity] || C.textMuted }} />
                {describeIssue(it, t, locale)}
              </div>
            ))
            : <div className="text-sm" style={{ color: C.textMuted }}>{t("dq.noIssues") || "No open issues."}</div>
        )}
        {tab === "warnings" && (
          <div className="text-sm" style={{ color: C.textMuted }}>
            {(q.inconsistent || 0) > 0
              ? `${q.inconsistent} ${t("dq.inconsistentValuesFound") || "inconsistent category values found (e.g. casing mismatches)."}`
              : (t("dq.noWarnings") || "No warnings.")}
          </div>
        )}
        {tab === "mapping" && (
          <div className="text-sm" style={{ color: C.textMuted }}>
            {t("dq.mappingHint") || "Column-to-field mapping is set during onboarding / Data Sources → Replace data."}
          </div>
        )}
        {tab === "skipped" && (
          <div className="text-sm" style={{ color: C.textMuted }}>
            {q.unmapped ? `${q.unmapped} ${t("dq.rowsSkipped") || "rows skipped (unmapped or unparsable)."}` : (t("dq.noneSkipped") || "No rows were skipped.")}
          </div>
        )}
        {tab === "syncHistory" && <SyncHistory dataSourceId={sourceInfo?.dataSourceId} />}
        {tab === "lineage" && (
          <div className="text-sm" style={{ color: C.textMuted }}>
            {t("dq.lineagePending") || "Data lineage (source column → unified field → analytics metric) is planned; today the mapping step is the only transformation tracked."}
          </div>
        )}
      </Card>
    </div>
  );
}
