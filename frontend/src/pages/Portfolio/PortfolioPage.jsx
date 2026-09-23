import React, { useEffect, useMemo, useRef, useState } from "react";
import { Upload, TrendingUp, TrendingDown, RefreshCw, Loader2, PiggyBank } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch, apiUpload, pollJob } from "../../api/client";
import { Card, SectionTitle, EmptyState, JobProgress, useToast } from "../../components/ui";

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

export default function PortfolioPage({ user }) {
  const { t, locale } = useLang();
  const toast = useToast();
  const canManage = MANAGER_AND_ABOVE.includes(user?.role);
  const fileInput = useRef(null);

  const [holdings, setHoldings] = useState([]);
  const [totals, setTotals] = useState({ custoTotal: 0, valorAtual: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [preview, setPreview] = useState(null); // { stagingId, headers, sampleRows, suggestedMapping, issues, ... }
  const [mapping, setMapping] = useState({});
  const [fileName, setFileName] = useState("");
  const [importJob, setImportJob] = useState(null); // { stage, progress }
  const [busy, setBusy] = useState(false);

  const [priceForm, setPriceForm] = useState({ ticker: "", preco: "", moeda: "EUR" });
  const [savingPrice, setSavingPrice] = useState(false);

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

  useEffect(() => { loadHoldings(); }, []);

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
    } catch (e) {
      toast.error(e.message || t("portfolio.error.priceForm"));
    } finally {
      setSavingPrice(false);
    }
  };

  const sortedHoldings = useMemo(
    () => [...holdings].sort((a, b) => (b.valorAtual ?? b.custoTotal) - (a.valorAtual ?? a.custoTotal)),
    [holdings]
  );

  return (
    <div>
      <SectionTitle eyebrow={t("nav.portfolio")} title={t("nav.portfolio")} desc={t("portfolio.desc")} />

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
            <div className="grid grid-cols-8 gap-2 px-4 py-2 text-xs font-semibold" style={{ background: C.greyBg, color: C.textSecondary }}>
              <div>{t("portfolio.field.ticker")}</div>
              <div>{t("portfolio.field.name")}</div>
              <div className="text-right">{t("portfolio.field.quantity")}</div>
              <div className="text-right">{t("portfolio.field.avgPrice")}</div>
              <div className="text-right">{t("portfolio.kpi.costBasis")}</div>
              <div className="text-right">{t("portfolio.field.currentPrice")}</div>
              <div className="text-right">{t("portfolio.kpi.currentValue")}</div>
              <div className="text-right">{t("portfolio.kpi.gainLoss")}</div>
            </div>
            {sortedHoldings.map((h) => {
              const gain = h.ganhoPerdaAbs;
              return (
                <div key={h.ticker} className="grid grid-cols-8 gap-2 px-4 py-2.5 text-sm items-center" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
                  <div className="font-medium" style={{ color: C.charcoal }}>{h.ticker}</div>
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
                </div>
              );
            })}
          </Card>
        </>
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
        </Card>
      )}
    </div>
  );
}
