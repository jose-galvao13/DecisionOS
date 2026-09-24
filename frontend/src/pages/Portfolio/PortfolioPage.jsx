import React, { useEffect, useMemo, useRef, useState } from "react";
import { Upload, TrendingUp, TrendingDown, RefreshCw, Loader2, PiggyBank, AlertTriangle, Trash2 } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import { C, chartTooltip, barCursor } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch, apiUpload, pollJob } from "../../api/client";
import { Card, SectionTitle, EmptyState, JobProgress, KPI, Pill, useToast } from "../../components/ui";
import RiskTab from "./RiskTab";

// Mirrors DecisionOSApp.jsx's MANAGER_AND_ABOVE — kept as its own copy so
// this page has no import-time dependency on the shell.
const MANAGER_AND_ABOVE = ["manager", "finance", "admin", "owner"];

// The mapping fields the preview screen lets a person confirm/correct
// before committing. `required` ones must all be set or /commit is
// refused (backend enforces the same three-plus-price rule — this is
// just the same rule surfaced early, in the UI).
const MAPPING_FIELDS = [
  { key: "ticker", labelKey: "portfolio.field.ticker", required: true },
  { key: "quantity", labelKey: "portfolio.field.quantity", required: true },
  { key: "avg_price", labelKey: "portfolio.field.avgPrice", required: true },
  { key: "currency", labelKey: "portfolio.field.currency", required: true },
  { key: "nome", labelKey: "portfolio.field.name", required: false },
  { key: "date", labelKey: "portfolio.field.purchaseDate", required: false },
  { key: "sector", labelKey: "portfolio.field.sector", required: false },
  { key: "region", labelKey: "portfolio.field.country", required: false },
  { key: "asset_type", labelKey: "portfolio.field.assetType", required: false },
];

function formatMoney(value, currency, locale) {
  if (value == null || !isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency || "EUR", maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency || ""}`.trim();
  }
}

// Small horizontal bar chart for one exposure dimension (moeda/sector/pais).
// Same visual language as BusinessIntelligence.jsx's byRegion chart (vertical
// bar, no axis line, chartTooltip/barCursor from the shared theme) so this
// page doesn't invent a second chart style.
function ExposureBars({ data, t }) {
  if (!data || !data.length) {
    return <div className="text-sm py-6 text-center" style={{ color: C.textMuted }}>{t("portfolio.exposure.empty")}</div>;
  }
  const height = Math.max(80, data.length * 34);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ left: 10, right: 20 }}>
        <CartesianGrid stroke={C.greyBorderSoft} horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 12, fill: C.textMuted }} axisLine={false} tickLine={false} tickFormatter={(v) => `${Math.round(v)}%`} domain={[0, "dataMax"]} />
        <YAxis type="category" dataKey="key" tick={{ fontSize: 12, fill: C.textSecondary }} axisLine={false} tickLine={false} width={70} />
        <Tooltip {...chartTooltip} cursor={barCursor} formatter={(v) => `${v.toFixed(1)}%`} />
        <Bar dataKey="pesoPct" radius={[0, 6, 6, 0]} fill={C.blue} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function PortfolioPage({ user }) {
  const { t, locale } = useLang();
  const toast = useToast();
  const canManage = MANAGER_AND_ABOVE.includes(user?.role);
  const fileInput = useRef(null);

  const [holdings, setHoldings] = useState([]);
  const [totals, setTotals] = useState({ custoTotal: 0, valorAtual: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [analytics, setAnalytics] = useState(null);
  const [analyticsError, setAnalyticsError] = useState("");

  const [preview, setPreview] = useState(null); // { stagingId, headers, sampleRows, suggestedMapping, issues, ... }
  const [mapping, setMapping] = useState({});
  const [fileName, setFileName] = useState("");
  const [importJob, setImportJob] = useState(null); // { stage, progress }
  const [busy, setBusy] = useState(false);

  const [priceForm, setPriceForm] = useState({ ticker: "", preco: "", moeda: "EUR" });
  const [savingPrice, setSavingPrice] = useState(false);
  const [uploadingPrices, setUploadingPrices] = useState(false);
  const priceFileInput = useRef(null);

  // Parte 2, FASE 3 — "Risco" gets its own tab (RiskTab.jsx), with its own
  // upload/API/GET-risk lifecycle entirely separate from holdings above.
  const [tab, setTab] = useState("holdings");

  // Every upload is its own import and positions from all imports are summed
  // by ticker, so re-uploading a file doubles it. This list is how a manager
  // removes one (DELETE /api/portfolio/:id — positions cascade, prices stay).
  const [imports, setImports] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  const loadImports = async () => {
    try {
      const data = await apiFetch("/api/portfolio/imports");
      setImports(data.imports || []);
    } catch {
      /* the list is a convenience; the page works without it */
    }
  };
  const deleteImport = async (imp) => {
    if (!window.confirm(t("portfolio.imports.deleteConfirm", { name: imp.name, n: imp.row_count }))) return;
    setDeletingId(imp.id);
    try {
      await apiFetch(`/api/portfolio/${imp.id}`, { method: "DELETE" });
      toast.success(t("portfolio.imports.deleted"));
      await Promise.all([loadImports(), loadHoldings(), loadAnalytics()]);
    } catch (e) {
      toast.error(e.message || t("portfolio.error.load"));
    } finally {
      setDeletingId(null);
    }
  };

  const loadHoldings = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/api/portfolio/holdings");
      setHoldings(data.holdings || []);
      setTotals(data.totals || { custoTotal: 0, valorAtual: 0 });
    } catch (e) {
      setError(e.message || t("portfolio.error.load"));
    } finally {
      setLoading(false);
    }
  };

  // Weights/HHI/exposure/warnings — computed server-side (FASE 2) from the
  // same positions, cached 60s. Loaded alongside holdings, but its own
  // failure doesn't block the (more essential) positions table/KPIs above.
  const loadAnalytics = async () => {
    setAnalyticsError("");
    try {
      const data = await apiFetch("/api/portfolio/analytics");
      setAnalytics(data);
    } catch (e) {
      setAnalyticsError(e.message || t("portfolio.error.analytics"));
    }
  };

  useEffect(() => { loadHoldings(); loadAnalytics(); loadImports(); }, []);

  const totalGainAbs = totals.valorAtual - totals.custoTotal;
  const totalGainPct = totals.custoTotal ? (totalGainAbs / totals.custoTotal) * 100 : 0;

  const handleFile = async (file) => {
    if (!file) return;
    setError("");
    setFileName(file.name);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiUpload("/api/portfolio/preview", fd);
      setPreview(res);
      setMapping(res.suggestedMapping || {});
    } catch (e) {
      toast.error(e.message || t("portfolio.error.preview"));
      setPreview(null);
    }
  };

  const mappingComplete = MAPPING_FIELDS.filter((f) => f.required).every((f) => mapping[f.key]);

  const handleCommit = async () => {
    if (!preview || !mappingComplete) return;
    setBusy(true);
    setImportJob({ progress: 0, stage: "queued" });
    try {
      const queued = await apiFetch("/api/portfolio/commit", {
        method: "POST",
        body: { stagingId: preview.stagingId, mapping, name: fileName },
      });
      const finished = await pollJob(queued.jobId, {
        path: "/api/datasources/jobs", // generic job lookup — see api/client.js
        onProgress: setImportJob,
      });
      toast.success(t("portfolio.importSuccess", { n: finished.result?.imported ?? 0 }));
      setPreview(null);
      setFileName("");
      await loadHoldings();
      await loadAnalytics();
      await loadImports();
    } catch (e) {
      toast.error(e.message || t("portfolio.error.commit"));
    } finally {
      setBusy(false);
      setImportJob(null);
    }
  };

  const savePrice = async () => {
    const ticker = priceForm.ticker.trim().toUpperCase();
    const preco = Number(priceForm.preco);
    const moeda = priceForm.moeda.trim().toUpperCase();
    if (!ticker || !isFinite(preco) || preco <= 0 || !/^[A-Z]{3}$/.test(moeda)) {
      toast.error(t("portfolio.error.priceForm"));
      return;
    }
    setSavingPrice(true);
    try {
      await apiFetch("/api/portfolio/prices", { method: "PUT", body: { ticker, preco, moeda } });
      toast.success(t("portfolio.priceSaved", { ticker }));
      setPriceForm({ ticker: "", preco: "", moeda });
      await loadHoldings();
      await loadAnalytics();
    } catch (e) {
      toast.error(e.message || t("portfolio.error.priceForm"));
    } finally {
      setSavingPrice(false);
    }
  };

  // Bulk pricing: POST /api/portfolio/prices/upload takes a whole sheet of
  // Ticker | Preço [| Moeda | Data] so a big portfolio isn't priced one
  // ticker at a time. Valid rows are saved even if others are skipped.
  const uploadPrices = async (file) => {
    if (!file) return;
    setUploadingPrices(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiUpload("/api/portfolio/prices/upload", fd);
      toast.success(t("portfolio.prices.success", { n: res.imported }));
      if (res.skipped > 0) {
        const first = res.issues?.[0];
        toast.error(t("portfolio.prices.skipped", { n: res.skipped, row: first?.row ?? "?", reason: first ? t(`portfolio.prices.reason.${first.reason}`) : "" }));
      }
      if (res.notHeld?.length) {
        toast.error(t("portfolio.prices.notHeld", { n: res.notHeld.length, tickers: res.notHeld.slice(0, 5).join(", ") }));
      }
      await loadHoldings();
      await loadAnalytics();
    } catch (e) {
      toast.error(e.message || t("portfolio.prices.error"));
    } finally {
      setUploadingPrices(false);
      if (priceFileInput.current) priceFileInput.current.value = "";
    }
  };

  const sortedHoldings = useMemo(
    () => [...holdings].sort((a, b) => (b.valorAtual ?? b.custoTotal) - (a.valorAtual ?? a.custoTotal)),
    [holdings]
  );

  // Ticker -> { pesoPct, semPreco, semTaxaCambio } from GET /api/portfolio/analytics,
  // to annotate the positions table below without re-deriving any of it client-side.
  const analyticsByTicker = useMemo(
    () => Object.fromEntries((analytics?.positions || []).map((p) => [p.ticker, p])),
    [analytics]
  );

  return (
    <div>
      <SectionTitle eyebrow={t("nav.portfolio")} title={t("nav.portfolio")} desc={t("portfolio.desc")} />

      {/* Tabs — Parte 2, FASE 3 adds "Risco" next to the original holdings view. */}
      <div className="flex gap-1 mt-2 mb-5 border-b" style={{ borderColor: C.greyBorderSoft }}>
        {[
          { id: "holdings", label: t("portfolio.tab.holdings") },
          { id: "risk", label: t("portfolio.tab.risk") },
        ].map((tb) => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className="px-3 py-2 text-sm"
            style={tab === tb.id ? { color: C.blue, borderBottom: `2px solid ${C.blue}`, fontWeight: 600 } : { color: C.textSecondary }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "risk" ? (
        <RiskTab canManage={canManage} />
      ) : (
      <>
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
            <button
              onClick={() => fileInput.current?.click()}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
              style={{ background: C.blue, color: "white" }}
            >
              <Upload size={15} /> {t("portfolio.uploadCta")}
            </button>
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
                    <div className="mb-1" style={{ color: C.textSecondary }}>
                      {t(f.labelKey)}{f.required && " *"}
                    </div>
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
                  stageLabels={{ queued: t("portfolio.job.queued"), importing: t("portfolio.job.importing"), completed: t("portfolio.job.completed") }}
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

      {analytics?.warnings?.length > 0 && (
        <Card className="p-4 mb-5" style={{ borderColor: C.yellow }}>
          <div className="flex items-center gap-2 mb-2 text-sm font-semibold" style={{ color: C.yellow }}>
            <AlertTriangle size={15} /> {t("portfolio.warning.title")}
          </div>
          <div className="space-y-1">
            {analytics.warnings.map((w) => (
              <div key={w.code} className="text-xs px-2 py-1 rounded" style={{ background: C.yellowSoft, color: C.yellow }}>
                {w.code === "sem_preco" && t("portfolio.warning.semPreco", { n: w.count ?? w.tickers?.length })}
                {w.code === "sem_taxa_cambio" && t("portfolio.warning.semTaxaCambio", { n: w.count ?? w.tickers?.length, currency: analytics.defaultCurrency })}
                {w.code === "sector_nd" && t("portfolio.warning.sectorNd", { n: w.count })}
                {w.code === "pais_nd" && t("portfolio.warning.paisNd", { n: w.count })}
              </div>
            ))}
          </div>
        </Card>
      )}

      {error && !holdings.length ? (
        <EmptyState icon={PiggyBank} title={t("portfolio.error.load")} desc={error} />
      ) : loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin" color={C.textMuted} /></div>
      ) : !holdings.length ? (
        <EmptyState icon={PiggyBank} title={t("portfolio.empty.title")} desc={t("portfolio.empty.desc")} />
      ) : (
        <>
          <div className="flex gap-3 mb-5 flex-wrap">
            <Card className="p-5 flex-1 min-w-[190px]">
              <div className="text-sm" style={{ color: C.textSecondary }}>{t("portfolio.kpi.costBasis")}</div>
              <div className="mt-2 tabnum text-3xl font-semibold" style={{ color: C.charcoal }}>{formatMoney(totals.custoTotal, "EUR", locale)}</div>
            </Card>
            <Card className="p-5 flex-1 min-w-[190px]">
              <div className="text-sm" style={{ color: C.textSecondary }}>{t("portfolio.kpi.currentValue")}</div>
              <div className="mt-2 tabnum text-3xl font-semibold" style={{ color: C.charcoal }}>{formatMoney(totals.valorAtual, "EUR", locale)}</div>
            </Card>
            <Card className="p-5 flex-1 min-w-[190px]">
              <div className="text-sm" style={{ color: C.textSecondary }}>{t("portfolio.kpi.gainLoss")}</div>
              <div className="mt-2 flex items-center gap-1.5 tabnum text-3xl font-semibold" style={{ color: totalGainAbs >= 0 ? C.green : C.red }}>
                {totalGainAbs >= 0 ? <TrendingUp size={20} /> : <TrendingDown size={20} />}
                {formatMoney(totalGainAbs, "EUR", locale)}
              </div>
              <div className="mt-1 text-sm" style={{ color: totalGainAbs >= 0 ? C.green : C.red }}>{totalGainPct.toFixed(1)}%</div>
            </Card>
          </div>

          <Card className="p-0 overflow-hidden">
            <div className="grid grid-cols-9 gap-2 px-4 py-2 text-xs font-semibold" style={{ background: C.greyBg, color: C.textSecondary }}>
              <div>{t("portfolio.field.ticker")}</div>
              <div>{t("portfolio.field.name")}</div>
              <div className="text-right">{t("portfolio.field.quantity")}</div>
              <div className="text-right">{t("portfolio.field.avgPrice")}</div>
              <div className="text-right">{t("portfolio.kpi.costBasis")}</div>
              <div className="text-right">{t("portfolio.field.currentPrice")}</div>
              <div className="text-right">{t("portfolio.kpi.currentValue")}</div>
              <div className="text-right">{t("portfolio.kpi.gainLoss")}</div>
              <div className="text-right">{t("portfolio.field.weight")}</div>
            </div>
            {sortedHoldings.map((h) => {
              const gain = h.ganhoPerdaAbs;
              const a = analyticsByTicker[h.ticker];
              return (
                <div key={h.ticker} className="grid grid-cols-9 gap-2 px-4 py-2.5 text-sm items-center" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
                  <div className="font-medium flex items-center gap-1.5" style={{ color: C.charcoal }}>
                    {h.ticker}
                    {a?.semPreco && <Pill tone="yellow">{t("portfolio.field.noQuote")}</Pill>}
                    {a?.semTaxaCambio && <Pill tone="yellow">{t("portfolio.field.noFxRate")}</Pill>}
                  </div>
                  <div className="truncate" style={{ color: C.textSecondary }}>{h.nome || "—"}</div>
                  <div className="text-right tabnum" style={{ color: C.charcoal }}>{h.quantidade.toLocaleString(locale)}</div>
                  <div className="text-right tabnum" style={{ color: C.charcoal }}>{formatMoney(h.precoMedio, h.moeda, locale)}</div>
                  <div className="text-right tabnum" style={{ color: C.charcoal }}>{formatMoney(h.custoTotal, h.moeda, locale)}</div>
                  <div className="text-right tabnum" style={{ color: h.precoAtual == null ? C.textMuted : C.charcoal }}>
                    {h.precoAtual != null ? formatMoney(h.precoAtual, h.moeda, locale) : t("portfolio.field.noQuote")}
                  </div>
                  <div className="text-right tabnum" style={{ color: C.charcoal }}>{h.valorAtual != null ? formatMoney(h.valorAtual, h.moeda, locale) : "—"}</div>
                  <div className="text-right tabnum" style={{ color: gain == null ? C.textMuted : gain >= 0 ? C.green : C.red }}>
                    {gain != null ? `${gain >= 0 ? "+" : ""}${h.ganhoPerdaPct.toFixed(1)}%` : "—"}
                  </div>
                  <div className="text-right tabnum" style={{ color: a?.pesoPct == null ? C.textMuted : C.charcoal }}>
                    {a?.pesoPct != null ? `${a.pesoPct.toFixed(1)}%` : "—"}
                  </div>
                </div>
              );
            })}
          </Card>

          {analytics && (
            <div className="mt-6">
              <SectionTitle title={t("portfolio.analytics.title")} />

              <div className="flex gap-3 mb-5 flex-wrap">
                <KPI label={t("portfolio.kpi.currentValue")} value={formatMoney(analytics.totals.valorAtual, analytics.defaultCurrency, locale)} />
                <KPI
                  label={t("portfolio.kpi.unrealizedPnl")}
                  value={formatMoney(analytics.totals.pnlNaoRealizado, analytics.defaultCurrency, locale)}
                  delta={analytics.totals.pnlNaoRealizadoPct != null ? `${analytics.totals.pnlNaoRealizadoPct >= 0 ? "+" : ""}${analytics.totals.pnlNaoRealizadoPct.toFixed(1)}%` : null}
                  deltaTone={analytics.totals.pnlNaoRealizado >= 0 ? "green" : "red"}
                />
                <KPI label={t("portfolio.kpi.hhi")} value={analytics.concentration.hhi.toFixed(3)} />
                <KPI label={t("portfolio.kpi.effectiveN")} value={analytics.concentration.effectiveN.toFixed(1)} />
              </div>

              {analytics.concentration.top3.length > 0 && (
                <Card className="p-5 mb-5">
                  <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>
                    {t("portfolio.kpi.top3")} — {t("portfolio.concentration.top3Desc", { pct: analytics.concentration.top3Pct.toFixed(1) })}
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {analytics.concentration.top3.map((p) => (
                      <Pill key={p.ticker} tone="blue">{p.ticker} · {p.pesoPct.toFixed(1)}%</Pill>
                    ))}
                  </div>
                </Card>
              )}

              <div className="grid grid-cols-3 gap-4">
                <Card className="p-5">
                  <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("portfolio.exposure.byCurrency")}</div>
                  <ExposureBars data={analytics.exposures.byCurrency} t={t} />
                </Card>
                <Card className="p-5">
                  <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("portfolio.exposure.bySector")}</div>
                  <ExposureBars data={analytics.exposures.bySector} t={t} />
                </Card>
                <Card className="p-5">
                  <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("portfolio.exposure.byCountry")}</div>
                  <ExposureBars data={analytics.exposures.byCountry} t={t} />
                </Card>
              </div>
            </div>
          )}
        </>
      )}

      {canManage && imports.length > 0 && (
        <Card className="p-4 mt-5">
          <div className="text-sm font-semibold mb-3" style={{ color: C.charcoal }}>{t("portfolio.imports.title")}</div>
          <div className="space-y-2">
            {imports.map((imp) => (
              <div key={imp.id} className="flex items-center justify-between gap-3 text-sm">
                <div style={{ color: C.charcoal }}>
                  {imp.name} <span style={{ color: C.textMuted }}>· {t("portfolio.imports.rows", { n: imp.row_count })} · {String(imp.created_at).slice(0, 10)}</span>
                </div>
                <button
                  onClick={() => deleteImport(imp)}
                  disabled={deletingId === imp.id}
                  aria-label={`${t("portfolio.imports.delete")} ${imp.name}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs"
                  style={{ border: `1px solid ${C.greyBorder}`, color: C.red }}
                >
                  {deletingId === imp.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />} {t("portfolio.imports.delete")}
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {canManage && (
        <Card className="p-4 mt-5">
          <div className="text-sm font-semibold mb-3" style={{ color: C.charcoal }}>{t("portfolio.updatePrice")}</div>
          <div className="flex items-end gap-2 flex-wrap">
            <label className="text-xs">
              <div className="mb-1" style={{ color: C.textSecondary }}>{t("portfolio.field.ticker")}</div>
              <input value={priceForm.ticker} onChange={(e) => setPriceForm((f) => ({ ...f, ticker: e.target.value }))}
                className="px-2 py-1.5 rounded-lg text-sm w-28" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }} />
            </label>
            <label className="text-xs">
              <div className="mb-1" style={{ color: C.textSecondary }}>{t("portfolio.field.currentPrice")}</div>
              <input type="number" step="0.01" value={priceForm.preco} onChange={(e) => setPriceForm((f) => ({ ...f, preco: e.target.value }))}
                className="px-2 py-1.5 rounded-lg text-sm w-28" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }} />
            </label>
            <label className="text-xs">
              <div className="mb-1" style={{ color: C.textSecondary }}>{t("portfolio.field.currency")}</div>
              <input value={priceForm.moeda} onChange={(e) => setPriceForm((f) => ({ ...f, moeda: e.target.value }))}
                className="px-2 py-1.5 rounded-lg text-sm w-20" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }} />
            </label>
            <button onClick={savePrice} disabled={savingPrice} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              style={{ background: C.blue, color: "white" }}>
              {savingPrice ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} {t("portfolio.savePrice")}
            </button>
          </div>
          <div className="mt-4 pt-4 flex items-center gap-3 flex-wrap" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
            <input
              ref={priceFileInput} type="file" accept=".xlsx,.xls,.csv" className="hidden"
              aria-label={t("portfolio.prices.upload")}
              onChange={(e) => uploadPrices(e.target.files?.[0])}
            />
            <button onClick={() => priceFileInput.current?.click()} disabled={uploadingPrices}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
              style={{ border: `1px solid ${C.blue}`, color: C.blue }}>
              {uploadingPrices ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {t("portfolio.prices.upload")}
            </button>
            <span className="text-xs" style={{ color: C.textMuted }}>{t("portfolio.prices.hint")}</span>
          </div>
        </Card>
      )}
      </>
      )}
    </div>
  );
}
