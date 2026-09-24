import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, AlertTriangle, Info, ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch } from "../../api/client";
import { Card, EmptyState, Tooltip } from "../../components/ui";

/* ---------------------------------------------------------------
   DECISION SIMULATOR — "Carteira de ações" tab (Parte 2, FASE 4).

   "What if I sold X% of a position?" — POST /api/simulate with
   type: 'sell_position' (simulateSellPosition in the backend's
   simulationEngine.js) returns the weights, HHI and historical VaR
   before and after; this tab only renders it.

   Deliberately neutral about the outcome: a smaller HHI or VaR is not
   painted green, nor a bigger one red — that would read as "this sale
   is good/bad". Changes are shown as plain signed deltas, and the
   not-financial-advice notice is always on screen.
----------------------------------------------------------------*/

function formatMoney(value, currency, locale) {
  if (value == null || !isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: currency || "EUR", maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${Number(value).toFixed(2)} ${currency || ""}`.trim();
  }
}

const num = (v, digits, locale) => Number(v).toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (v, digits, locale) => `${v > 0 ? "+" : ""}${num(v, digits, locale)}`;

function Delta({ value, text }) {
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span className="inline-flex items-center gap-0.5 tabnum text-xs" style={{ color: C.textSecondary }}>
      <Icon size={12} /> {text}
    </span>
  );
}

function Metric({ label, before, after, delta, deltaText, beforeLabel, afterLabel }) {
  return (
    <div className="p-4 rounded-xl" style={{ background: C.greyBg }}>
      <div className="text-sm" style={{ color: C.textSecondary }}>{label}</div>
      <div className="mt-2 flex items-baseline gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-wide" style={{ color: C.textMuted }}>{beforeLabel}</div>
          <div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{before}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide" style={{ color: C.textMuted }}>{afterLabel}</div>
          <div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{after}</div>
        </div>
      </div>
      {deltaText != null && <div className="mt-1"><Delta value={delta} text={deltaText} /></div>}
    </div>
  );
}

function PortfolioSellTab() {
  const { t, locale } = useLang();
  const [portfolio, setPortfolio] = useState(null); // GET /api/portfolio/analytics
  const [loadError, setLoadError] = useState(false);
  const [ticker, setTicker] = useState("");
  const [percent, setPercent] = useState(25);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const debounceRef = useRef(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    let alive = true;
    apiFetch("/api/portfolio/analytics")
      .then((data) => { if (alive) setPortfolio(data); })
      .catch(() => { if (alive) setLoadError(true); });
    return () => { alive = false; };
  }, []);

  // Only positions that have a price and an fx rate have a weight — the
  // others can't be sized, so they aren't offered.
  const options = useMemo(
    () => (portfolio?.positions || []).filter((p) => p.pesoPct != null).sort((a, b) => b.pesoPct - a.pesoPct),
    [portfolio]
  );
  useEffect(() => {
    if (!ticker && options.length) setTicker(options[0].ticker);
  }, [options, ticker]);

  useEffect(() => {
    if (!ticker) return undefined;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError("");
      try {
        const data = await apiFetch("/api/simulate", { method: "POST", body: { type: "sell_position", ticker, percent } });
        if (seq === requestSeq.current) setResult(data);
      } catch {
        if (seq === requestSeq.current) { setResult(null); setError(t("sim.portfolio.error")); }
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    }, 300); // avoid firing on every slider pixel
    return () => clearTimeout(debounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker, percent]);

  if (loadError) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>
        <AlertTriangle size={14} /> {t("sim.portfolio.loadError")}
      </div>
    );
  }
  if (!portfolio) {
    return <div className="flex justify-center py-16"><Loader2 size={22} className="animate-spin" color={C.textMuted} /></div>;
  }
  if (!portfolio.positions?.length) {
    return <EmptyState icon={Info} title={t("portfolio.empty.title")} desc={t("portfolio.empty.desc")} />;
  }
  if (!options.length) {
    return <EmptyState icon={Info} desc={t("sim.portfolio.noPriced")} />;
  }

  const currency = result?.currency || portfolio.defaultCurrency;
  const money = (v) => formatMoney(v, currency, locale);

  const warningText = (w) => {
    const tickers = (w.tickers || []).join(", ");
    switch (w.code) {
      case "positions_outside": return t("sim.portfolio.warning.positions_outside", { n: (w.tickers || []).length, tickers });
      case "var_partial_coverage": return t("sim.portfolio.warning.var_partial_coverage", { pct: num(w.coveredWeightPct, 1, locale), tickers });
      case "fx_not_modelled": return t("sim.portfolio.warning.fx_not_modelled", { tickers, currency });
      case "single_position": return t("sim.portfolio.warning.single_position");
      case "var_insufficient_data": return t("portfolio.risk.insufficientDataHint", { n: w.minObservations, have: w.observations });
      default: return w.message || w.code;
    }
  };

  const VarCell = ({ v }) => (
    v.pct == null ? (
      <div className="flex items-center gap-1.5 text-sm" style={{ color: C.textMuted }}>
        {t("portfolio.risk.insufficientData")}
      </div>
    ) : (
      <>
        <div className="tabnum text-lg font-semibold" style={{ color: C.charcoal }}>{num(v.pct, 2, locale)}%</div>
        <div className="text-xs" style={{ color: C.textMuted }}>{t("sim.portfolio.var.amount", { amount: money(v.amount) })}</div>
      </>
    )
  );

  const r = result;
  const varAvailable = r && r.current.var95.pct != null && r.scenario.var95.pct != null;

  return (
    <div className="grid grid-cols-3 gap-6">
      <Card className="p-6 col-span-1">
        <div className="text-sm font-semibold mb-4" style={{ color: C.charcoal }}>{t("sim.portfolio.controls")}</div>

        <label className="block mb-5">
          <span className="block text-sm font-medium mb-2" style={{ color: C.charcoal }}>{t("sim.portfolio.position")}</span>
          <select
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            aria-label={t("sim.portfolio.position")}
            className="w-full px-3 py-2 rounded-lg text-sm"
            style={{ background: C.greyBg, color: C.charcoal, border: `1px solid ${C.greyBorder}` }}
          >
            {options.map((p) => (
              <option key={p.ticker} value={p.ticker}>{p.ticker} — {num(p.pesoPct, 1, locale)}%</option>
            ))}
          </select>
        </label>

        <div className="mb-2">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium" style={{ color: C.charcoal }}>{t("sim.portfolio.percentSold")}</span>
            <span className="tabnum text-sm font-semibold" style={{ color: C.blue }}>{percent}%</span>
          </div>
          <input
            type="range" min={5} max={100} step={5} value={percent}
            aria-label={t("sim.portfolio.percentSold")}
            onChange={(e) => setPercent(Number(e.target.value))}
            className="w-full" style={{ accentColor: C.blue }}
          />
        </div>
        {r && !r.error && <div className="text-xs mt-3" style={{ color: C.textSecondary }}>{t("sim.portfolio.proceeds", { value: money(r.proceeds) })}</div>}
      </Card>

      <Card className="p-6 col-span-2">
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("sim.portfolio.title")}</div>
          {loading && <Loader2 size={14} className="animate-spin" color={C.textMuted} />}
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg text-sm mb-4" style={{ background: C.redSoft, color: C.red }}>
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        {r && !r.error && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <Metric
                label={t("sim.portfolio.metric.hhi")}
                before={num(r.current.hhi, 3, locale)} after={num(r.scenario.hhi, 3, locale)}
                delta={r.impact.hhiDelta} deltaText={signed(r.impact.hhiDelta, 3, locale)}
                beforeLabel={t("sim.portfolio.before")} afterLabel={t("sim.portfolio.after")}
              />
              <Metric
                label={t("sim.portfolio.metric.effectiveN")}
                before={num(r.current.effectiveN, 2, locale)} after={num(r.scenario.effectiveN, 2, locale)}
                delta={r.impact.effectiveNDelta} deltaText={signed(r.impact.effectiveNDelta, 2, locale)}
                beforeLabel={t("sim.portfolio.before")} afterLabel={t("sim.portfolio.after")}
              />
              <Metric
                label={t("sim.portfolio.metric.largest")}
                before={`${num(r.current.largestPositionPct, 1, locale)}%`} after={`${num(r.scenario.largestPositionPct, 1, locale)}%`}
                delta={r.impact.largestPositionDeltaPP} deltaText={`${signed(r.impact.largestPositionDeltaPP, 1, locale)}pp`}
                beforeLabel={t("sim.portfolio.before")} afterLabel={t("sim.portfolio.after")}
              />
              <Metric
                label={t("sim.portfolio.metric.value")}
                before={money(r.current.totalValue)} after={money(r.scenario.totalValue)}
                delta={r.impact.valueDelta} deltaText={signed(r.impact.valueDelta, 2, locale)}
                beforeLabel={t("sim.portfolio.before")} afterLabel={t("sim.portfolio.after")}
              />
            </div>

            <div className="mt-4 p-4 rounded-xl" style={{ background: C.blueSoft }}>
              <div className="text-sm font-medium" style={{ color: C.blue }}>{t("sim.portfolio.metric.var95")}</div>
              <div className="mt-2 flex items-start gap-8">
                <div>
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: C.textMuted }}>{t("sim.portfolio.before")}</div>
                  <VarCell v={r.current.var95} />
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: C.textMuted }}>{t("sim.portfolio.after")}</div>
                  <VarCell v={r.scenario.var95} />
                </div>
                {varAvailable && (
                  <div className="self-end">
                    <Delta value={r.impact.var95DeltaPP} text={`${signed(r.impact.var95DeltaPP, 2, locale)}pp`} />
                  </div>
                )}
              </div>
              {!r.current.var95.insufficientData && (
                <div className="text-xs mt-2" style={{ color: C.textSecondary }}>
                  {t("sim.portfolio.var.window", { n: r.current.var95.observations, from: r.current.var95.from, to: r.current.var95.to })}
                </div>
              )}
            </div>

            {r.warnings?.length > 0 && (
              <div className="mt-4 space-y-2">
                {r.warnings.map((w) => (
                  <div key={w.code} className="flex items-start gap-2 p-3 rounded-lg text-xs" style={{ background: C.yellowSoft, color: C.charcoal }}>
                    <AlertTriangle size={13} color={C.yellow} className="mt-0.5 shrink-0" />
                    <span>{warningText(w)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5">
              <div className="text-sm font-semibold mb-2" style={{ color: C.charcoal }}>{t("sim.portfolio.weights.title")}</div>
              <div className="max-h-64 overflow-y-auto rounded-lg" style={{ border: `1px solid ${C.greyBorder}` }}>
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ color: C.textMuted, background: C.greyBg }}>
                      <th className="text-left font-medium px-3 py-2">{t("portfolio.risk.table.ticker")}</th>
                      <th className="text-right font-medium px-3 py-2">{t("sim.portfolio.before")}</th>
                      <th className="text-right font-medium px-3 py-2">{t("sim.portfolio.after")}</th>
                      <th className="text-right font-medium px-3 py-2">{t("sim.portfolio.weights.change")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.weights.map((w) => {
                      const diff = w.pesoAfterPct - w.pesoBeforePct;
                      const isSold = w.ticker === r.ticker;
                      return (
                        <tr key={w.ticker} style={{ borderTop: `1px solid ${C.greyBorderSoft}`, fontWeight: isSold ? 600 : 400 }}>
                          <td className="px-3 py-2" style={{ color: C.charcoal }}>{w.ticker}</td>
                          <td className="px-3 py-2 text-right tabnum" style={{ color: C.charcoal }}>{num(w.pesoBeforePct, 2, locale)}%</td>
                          <td className="px-3 py-2 text-right tabnum" style={{ color: C.charcoal }}>{num(w.pesoAfterPct, 2, locale)}%</td>
                          <td className="px-3 py-2 text-right tabnum" style={{ color: C.textSecondary }}>{signed(diff, 2, locale)}pp</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-5">
              <div className="flex items-center gap-1.5 text-sm font-semibold mb-2" style={{ color: C.charcoal }}>
                {t("sim.portfolio.assumptions.title")}
                <Tooltip label={t("sim.portfolio.assumptions.var")}><Info size={12} color={C.textMuted} /></Tooltip>
              </div>
              <ul className="space-y-1 text-xs list-disc pl-4" style={{ color: C.textSecondary }}>
                <li>{t("sim.portfolio.assumptions.proceeds")}</li>
                <li>{t("sim.portfolio.assumptions.price")}</li>
                <li>{t("sim.portfolio.assumptions.var")}</li>
                <li>{t("sim.portfolio.assumptions.limits")}</li>
              </ul>
            </div>
          </>
        )}

        <p className="mt-5 text-xs p-3 rounded-lg" role="note" style={{ background: C.greyBg, color: C.textSecondary }}>
          {t("sim.portfolio.disclaimer")}
        </p>
      </Card>
    </div>
  );
}

export default PortfolioSellTab;
