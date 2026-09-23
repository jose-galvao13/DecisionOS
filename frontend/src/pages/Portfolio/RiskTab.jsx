import React, { useEffect, useMemo, useRef, useState } from "react";
import { Upload, Loader2, LineChart as LineChartIcon, Cloud, Trash2 } from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { C, tint, chartTooltip } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch, apiUpload, pollJob } from "../../api/client";
import { Card, EmptyState, JobProgress, Pill, useToast } from "../../components/ui";

/* ---------------------------------------------------------------
   RISK TAB — Parte 2, FASE 3 ("Risco com histórico de preços").

   Same preview -> mapping -> commit -> poll shape as the "Carteira"
   tab's holdings upload (PortfolioPage.jsx), pointed at
   /api/portfolio/price-history/* instead of /api/portfolio/*, plus:
     - an optional "fetch via API" action (services/marketData.js)
     - GET /api/portfolio/risk, rendered as a volatility/VaR/beta
       table, a correlation heatmap, and a drawdown curve for one
       selected ticker at a time.
----------------------------------------------------------------*/

const MAPPING_FIELDS = [
  { key: "ticker", labelKey: "portfolio.field.ticker" },
  { key: "date", labelKey: "portfolio.risk.field.date" },
  { key: "close_price", labelKey: "portfolio.risk.field.closePrice" },
];

function pct(value, digits = 2) {
  return value == null ? "—" : `${value >= 0 ? "" : ""}${value.toFixed(digits)}%`;
}

function heatCellColor(value) {
  if (value == null) return C.greyBg;
  const strength = Math.round(Math.min(Math.abs(value), 1) * 65) + 8;
  return tint(value >= 0 ? C.green : C.red, strength);
}

function CorrelationHeatmap({ tickers, matrix, t }) {
  if (tickers.length < 2) {
    return <div className="text-sm py-6 text-center" style={{ color: C.textMuted }}>{t("portfolio.risk.correlation.empty")}</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs" style={{ minWidth: tickers.length * 56 + 60 }}>
        <thead>
          <tr>
            <th className="p-1" />
            {tickers.map((tk) => (
              <th key={tk} className="p-1 font-medium text-center" style={{ color: C.textSecondary }}>{tk}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tickers.map((rowTk) => (
            <tr key={rowTk}>
              <td className="p-1 pr-2 font-medium text-right" style={{ color: C.textSecondary }}>{rowTk}</td>
              {tickers.map((colTk) => {
                const v = matrix?.[rowTk]?.[colTk];
                return (
                  <td key={colTk} className="p-0">
                    <div
                      className="w-14 h-9 flex items-center justify-center tabnum"
                      style={{ background: heatCellColor(v), color: C.charcoal, fontSize: 11 }}
                      title={`${rowTk} × ${colTk}: ${v == null ? "n/d" : v.toFixed(2)}`}
                    >
                      {v == null ? "—" : v.toFixed(2)}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DrawdownChart({ curve }) {
  if (!curve?.length) return null;
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={curve} margin={{ left: 0, right: 10, top: 10 }}>
        <defs>
          <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.red} stopOpacity={0.35} />
            <stop offset="100%" stopColor={C.red} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={C.greyBorderSoft} vertical={false} />
        <XAxis dataKey="data" tick={{ fontSize: 11, fill: C.textMuted }} axisLine={false} tickLine={false} minTickGap={40} />
        <YAxis tick={{ fontSize: 11, fill: C.textMuted }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v.toFixed(0)}%`} />
        <Tooltip {...chartTooltip} formatter={(v) => [`${Number(v).toFixed(2)}%`, "Drawdown"]} />
        <Area type="monotone" dataKey="drawdownPct" stroke={C.red} strokeWidth={1.5} fill="url(#ddFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export default function RiskTab({ canManage }) {
  const { t } = useLang();
  const toast = useToast();
  const fileInput = useRef(null);

  const [risk, setRisk] = useState(null); // GET /api/portfolio/risk response
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [indexTicker, setIndexTicker] = useState("");
  const [selectedTicker, setSelectedTicker] = useState("");

  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [fileName, setFileName] = useState("");
  const [importJob, setImportJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fetchingApi, setFetchingApi] = useState(false);

  const loadRisk = async (index) => {
    setLoading(true);
    setError("");
    try {
      const qs = index ? `?index=${encodeURIComponent(index)}` : "";
      const data = await apiFetch(`/api/portfolio/risk${qs}`);
      setRisk(data);
      if (!selectedTicker && data.tickers?.length) setSelectedTicker(data.tickers[0]);
    } catch (e) {
      setError(e.message || t("portfolio.risk.error.load"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadRisk(indexTicker || null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [indexTicker]);

  const handleFile = async (file) => {
    if (!file) return;
    setFileName(file.name);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiUpload("/api/portfolio/price-history/preview", fd);
      setPreview(res);
      setMapping(res.suggestedMapping || {});
    } catch (e) {
      toast.error(e.message || t("portfolio.risk.error.preview"));
      setPreview(null);
    }
  };

  const mappingComplete = MAPPING_FIELDS.every((f) => mapping[f.key]);

  const handleCommit = async () => {
    if (!preview || !mappingComplete) return;
    setBusy(true);
    setImportJob({ progress: 0, stage: "queued" });
    try {
      const queued = await apiFetch("/api/portfolio/price-history/commit", {
        method: "POST",
        body: { stagingId: preview.stagingId, mapping },
      });
      const finished = await pollJob(queued.jobId, { onProgress: setImportJob });
      toast.success(t("portfolio.risk.importSuccess", { n: finished.result?.imported ?? 0 }));
      setPreview(null);
      setFileName("");
      await loadRisk(indexTicker || null);
    } catch (e) {
      toast.error(e.message || t("portfolio.risk.error.commit"));
    } finally {
      setBusy(false);
      setImportJob(null);
    }
  };

  const handleFetchApi = async () => {
    setFetchingApi(true);
    try {
      const res = await apiFetch("/api/portfolio/price-history/fetch", { method: "POST", body: {} });
      const ok = Object.keys(res.imported || {}).length;
      const fail = Object.keys(res.failed || {}).length;
      if (ok && !fail) toast.success(t("portfolio.risk.fetchApi.success", { n: ok }));
      else if (ok && fail) toast.info(t("portfolio.risk.fetchApi.partial", { ok, fail }));
      else toast.error(t("portfolio.risk.fetchApi.error"));
      await loadRisk(indexTicker || null);
    } catch (e) {
      toast.error(e.message || t("portfolio.risk.fetchApi.error"));
    } finally {
      setFetchingApi(false);
    }
  };

  const handleDelete = async (ticker) => {
    if (!window.confirm(t("portfolio.risk.deleteConfirm", { ticker }))) return;
    try {
      await apiFetch(`/api/portfolio/price-history/${encodeURIComponent(ticker)}`, { method: "DELETE" });
      if (selectedTicker === ticker) setSelectedTicker("");
      if (indexTicker === ticker) setIndexTicker("");
      await loadRisk(indexTicker === ticker ? null : indexTicker || null);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const tickers = risk?.tickers || [];
  const minObservations = risk?.minObservations;
  const selectedCurve = useMemo(
    () => (selectedTicker && risk?.perTicker?.[selectedTicker] ? risk.perTicker[selectedTicker].drawdownCurve : []),
    [risk, selectedTicker]
  );

  return (
    <div>
      {canManage && (
        <Card className="p-4 mb-5">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])}
          />
          {!preview ? (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => fileInput.current?.click()}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
                style={{ background: C.blue, color: "white" }}
              >
                <Upload size={15} /> {t("portfolio.risk.uploadCta")}
              </button>
              <button
                onClick={handleFetchApi}
                disabled={fetchingApi}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ border: `1px solid ${C.greyBorder}`, color: C.textSecondary }}
              >
                {fetchingApi ? <Loader2 size={14} className="animate-spin" /> : <Cloud size={14} />} {t("portfolio.risk.fetchApi")}
              </button>
            </div>
          ) : (
            <div>
              <div className="text-sm font-semibold mb-1" style={{ color: C.charcoal }}>
                {t("portfolio.preview.title", { name: fileName, n: preview.rowCount })}
              </div>
              {preview.issues?.length > 0 && (
                <div className="mb-3 space-y-1">
                  {preview.issues.map((iss, i) => (
                    <div key={i} className="text-xs px-2 py-1 rounded" style={{ background: iss.severity === "red" ? C.redSoft : C.yellowSoft, color: iss.severity === "red" ? C.red : C.yellow }}>
                      {iss.message}
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-3">
                {MAPPING_FIELDS.map((f) => (
                  <label key={f.key} className="text-xs">
                    <div className="mb-1" style={{ color: C.textSecondary }}>{t(f.labelKey)} *</div>
                    <select
                      value={mapping[f.key] || ""}
                      onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value || null }))}
                      className="w-full px-2 py-1.5 rounded-lg text-sm"
                      style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }}
                    >
                      <option value="">{t("portfolio.field.none")}</option>
                      {preview.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              {importJob ? (
                <JobProgress
                  progress={importJob.progress}
                  stage={importJob.stage}
                  stageLabels={{ queued: t("portfolio.job.queued"), importing: t("portfolio.risk.job.importing"), completed: t("portfolio.job.completed") }}
                />
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleCommit}
                    disabled={!mappingComplete || busy}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                    style={{ background: C.blue, color: "white" }}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : null} {t("portfolio.confirmImport")}
                  </button>
                  <button
                    onClick={() => { setPreview(null); setFileName(""); }}
                    className="px-3 py-2 rounded-lg text-sm"
                    style={{ border: `1px solid ${C.greyBorder}`, color: C.textSecondary }}
                  >
                    {t("data.cancel")}
                  </button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {error && !tickers.length ? (
        <EmptyState icon={LineChartIcon} title={t("portfolio.risk.error.load")} desc={error} />
      ) : loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin" color={C.textMuted} /></div>
      ) : !tickers.length ? (
        <EmptyState icon={LineChartIcon} title={t("portfolio.risk.empty.title")} desc={t("portfolio.risk.empty.desc")} />
      ) : (
        <>
          <div className="flex items-end gap-3 flex-wrap mb-5">
            <label className="text-xs">
              <div className="mb-1" style={{ color: C.textSecondary }}>{t("portfolio.risk.index.label")}</div>
              <select
                value={indexTicker}
                onChange={(e) => setIndexTicker(e.target.value)}
                className="px-2 py-1.5 rounded-lg text-sm"
                style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }}
              >
                <option value="">{t("portfolio.risk.index.none")}</option>
                {tickers.map((tk) => <option key={tk} value={tk}>{tk}</option>)}
              </select>
            </label>
          </div>

          <Card className="p-0 overflow-hidden mb-5">
            <div className="grid grid-cols-7 gap-2 px-4 py-2 text-xs font-semibold" style={{ background: C.greyBg, color: C.textSecondary }}>
              <div>{t("portfolio.risk.table.ticker")}</div>
              <div className="text-right">{t("portfolio.risk.table.observations")}</div>
              <div className="text-right">{t("portfolio.risk.table.volatility")}</div>
              <div className="text-right">{t("portfolio.risk.table.maxDrawdown")}</div>
              <div className="text-right">{t("portfolio.risk.table.var95")}</div>
              <div className="text-right">{t("portfolio.risk.table.beta")}</div>
              <div />
            </div>
            {tickers.map((tk) => {
              const m = risk.perTicker[tk];
              return (
                <div key={tk} className="grid grid-cols-7 gap-2 px-4 py-2.5 text-sm items-center" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
                  <button
                    onClick={() => setSelectedTicker(tk)}
                    className="text-left font-medium flex items-center gap-1.5"
                    style={{ color: tk === selectedTicker ? C.blue : C.charcoal }}
                  >
                    {tk}
                  </button>
                  <div className="text-right tabnum" style={{ color: C.textSecondary }}>{m.observations}</div>
                  {m.insufficientData ? (
                    <div className="col-span-3 text-right">
                      <span title={t("portfolio.risk.insufficientDataHint", { n: minObservations, have: m.observations })}>
                        <Pill tone="yellow">{t("portfolio.risk.insufficientData")}</Pill>
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="text-right tabnum" style={{ color: C.charcoal }}>{pct((m.volatilidadeAnualizada ?? 0) * 100)}</div>
                      <div className="text-right tabnum" style={{ color: C.red }}>{pct(m.maxDrawdownPct)}</div>
                      <div className="text-right tabnum" style={{ color: C.red }}>{pct(m.var95Pct)}</div>
                    </>
                  )}
                  <div className="text-right tabnum" style={{ color: C.charcoal }}>
                    {indexTicker && tk !== indexTicker
                      ? (m.beta != null ? m.beta.toFixed(2) : m.betaInsufficientData ? t("portfolio.risk.insufficientData") : "—")
                      : "—"}
                  </div>
                  <div className="text-right">
                    {canManage && (
                      <button onClick={() => handleDelete(tk)} title={t("portfolio.risk.deleteTicker")} style={{ color: C.textMuted }}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>

          <div className="grid grid-cols-2 gap-4">
            <Card className="p-5">
              <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("portfolio.risk.correlation.title")}</div>
              <CorrelationHeatmap tickers={tickers} matrix={risk.correlationMatrix} t={t} />
            </Card>
            <Card className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-medium" style={{ color: C.charcoal }}>{t("portfolio.risk.drawdown.title")}</div>
                <select
                  value={selectedTicker}
                  onChange={(e) => setSelectedTicker(e.target.value)}
                  className="px-2 py-1 rounded-lg text-xs"
                  style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }}
                >
                  {tickers.map((tk) => <option key={tk} value={tk}>{tk}</option>)}
                </select>
              </div>
              <DrawdownChart curve={selectedCurve} />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
