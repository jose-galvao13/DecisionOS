import React, { useState, useEffect, useRef } from "react";
import { X, Loader2, AlertTriangle, Info, ClipboardCheck } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK, fmtSigned } from "../../lib/format";
import { apiFetch } from "../../api/client";
import { Card, SectionTitle, SourceBadge, Tooltip, useToast } from "../../components/ui";
import PortfolioSellTab from "./PortfolioSellTab";

// P0 credibility fix: this page used to compute its own approximate
// impact client-side, with its own copy of the elasticity constants and a
// fabricated "90% CI" band (fixed 0.55x/1.4x multipliers applied to
// whatever number the sliders produced — never derived from anything).
// It now calls the same server-side Simulation Engine every other
// scenario in this app uses (POST /api/simulate, type: 'levers') and
// renders exactly what it returns: which parts are observed/estimated
// from this org's own data vs. a stated assumption, the actual
// methodology behind the estimated range, and the same confidence +
// data-coverage discipline the Decision Engine uses.
const SOURCE_META = {
  estimated: { label: "estimated from your data", color: C.blue },
  assumption: { label: "stated assumption", color: C.textMuted },
};

function LeverSourceTag({ source }) {
  const meta = SOURCE_META[source] || SOURCE_META.assumption;
  return (
    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded" style={{ background: C.greyBg, color: meta.color }}>
      {meta.label}
    </span>
  );
}

const RISK_META = { low: C.green, medium: C.yellow, high: C.red };

// The original (sales) simulator, unchanged apart from the page header and the
// source badge, which moved up into DecisionSimulator below now that the page
// has two tabs.
function BusinessSimulator({ filters }) {
  const { t, locale } = useLang();
  const toast = useToast();
  const [price, setPrice] = useState(5);
  const [marketing, setMarketing] = useState(-10);
  const [churn, setChurn] = useState(2);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await apiFetch("/api/simulate", {
          method: "POST",
          body: { type: "levers", pricePct: price, marketingPct: marketing, churnPct: churn, filters },
        });
        setResult(data);
        setCommitted(false);
      } catch (e) {
        setError(e.message || "Could not run the simulation");
      } finally {
        setLoading(false);
      }
    }, 300); // avoid firing on every slider pixel
    return () => clearTimeout(debounceRef.current);
  }, [price, marketing, churn, filters]);

  const Slider = ({ label, value, setValue, min, max }) => (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium" style={{ color: C.charcoal }}>{label}</span>
        <span className="tabnum text-sm font-semibold" style={{ color: C.blue }}>{value > 0 ? "+" : ""}{value}%</span>
      </div>
      <input type="range" min={min} max={max} value={value} onChange={(e) => setValue(Number(e.target.value))} className="w-full" style={{ accentColor: C.blue }} />
    </div>
  );

  const levers = result?.assumptions?.levers || [];
  const leverByName = Object.fromEntries(levers.map((l) => [l.lever, l]));

  // P2 "Simulation -> Decision": commits the current scenario (exact
  // lever inputs + the evidence-based range/confidence that came back
  // with it) straight into the Decision Log, same payload shape as the
  // Decision Feed's "Turn into a decision" (see DecisionFeed.jsx).
  const commitAsDecision = async () => {
    if (!result || result.error) return;
    setCommitting(true);
    try {
      await apiFetch("/api/decision-log", {
        method: "POST",
        body: {
          title: result.label || "Simulated scenario",
          description: `Price ${price >= 0 ? "+" : ""}${price}%, Marketing ${marketing >= 0 ? "+" : ""}${marketing}%, Churn ${churn >= 0 ? "+" : ""}${churn}%`,
          recommendation: `Review this scenario's estimated range and confidence before approving.`,
          sourceType: "simulation",
          // decisionEngine.js decisions carry a true 0-100 confidence score;
          // the Simulation Engine only returns a low/medium/high risk-based
          // label (see buildScenario in simulationEngine.js) — this is a
          // rough numeric stand-in so both sources fit the same column,
          // not a real percentage.
          confidence: { low: 30, medium: 60, high: 85 }[result.confidence] ?? null,
          sourceSnapshot: { levers, rangeMethodology: result.rangeMethodology, risk: result.risk, evidence: result.evidence },
          expectedImpact: { metric: "profit", low: result.impact.estimatedRange.low, high: result.impact.estimatedRange.high, currency: "EUR" },
        },
      });
      setCommitted(true);
      toast.success("Added to Decision Log as a proposed decision.");
    } catch (e) {
      toast.error(e.message || "Could not create the decision");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div>
      <div className="grid grid-cols-3 gap-6">
        <Card className="p-6 col-span-1">
          <div className="text-sm font-semibold mb-4" style={{ color: C.charcoal }}>{t("sim.levers")}</div>

          <Slider label={t("lever.price")} value={price} setValue={setPrice} min={-20} max={20} />
          {leverByName.price && (
            <div className="flex items-center gap-1.5 -mt-3 mb-4">
              <LeverSourceTag source={leverByName.price.source} />
              <Tooltip label={leverByName.price.basis}><Info size={12} color={C.textMuted} /></Tooltip>
            </div>
          )}

          <Slider label={t("lever.marketing")} value={marketing} setValue={setMarketing} min={-30} max={30} />
          {leverByName.marketing && (
            <div className="flex items-center gap-1.5 -mt-3 mb-4">
              <LeverSourceTag source={leverByName.marketing.source} />
              <Tooltip label={leverByName.marketing.basis}><Info size={12} color={C.textMuted} /></Tooltip>
            </div>
          )}

          <Slider label={t("lever.churn")} value={churn} setValue={setChurn} min={-10} max={10} />
          {leverByName.churn && (
            <div className="flex items-center gap-1.5 -mt-3 mb-4">
              <LeverSourceTag source={leverByName.churn.source} />
              <Tooltip label={leverByName.churn.basis}><Info size={12} color={C.textMuted} /></Tooltip>
            </div>
          )}
        </Card>

        <Card className="p-6 col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("sim.expectedImpact")}</div>
            {loading && <Loader2 size={14} className="animate-spin" color={C.textMuted} />}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg text-sm mb-4" style={{ background: C.redSoft, color: C.red }}>
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          {result && !result.error && (
            <>
              <div className="grid grid-cols-2 gap-4">
                {[
                  [t("impact.revenue"), fmtSigned(result.impact.revenueDelta, "€", locale), result.impact.revenueDelta >= 0],
                  [t("impact.profit"), fmtSigned(result.impact.profitDelta, "€", locale), result.impact.profitDelta >= 0],
                  [t("impact.margin"), `${result.impact.marginPPDelta >= 0 ? "+" : ""}${result.impact.marginPPDelta.toFixed(1)}pp`, result.impact.marginPPDelta >= 0],
                  [t("impact.customers"), `${result.impact.customersDeltaPct.toFixed(1)}%`, result.impact.customersDeltaPct >= 0],
                ].map(([label, val, pos]) => (
                  <div key={label} className="p-4 rounded-xl" style={{ background: C.greyBg }}>
                    <div className="text-sm" style={{ color: C.textSecondary }}>{label}</div>
                    <div className="tabnum text-xl font-semibold mt-1" style={{ color: pos ? C.green : C.red }}>{val}</div>
                  </div>
                ))}
              </div>

              {/* Confidence + data coverage — P0: every estimate here says how
                  much data it's based on and how much to trust it, the same
                  discipline the Decision Engine uses. */}
              <div className="flex items-center gap-3 mt-4 text-xs">
                <span
                  className="px-2 py-1 rounded-full font-medium"
                  style={{ background: `${RISK_META[result.risk] || C.textMuted}22`, color: RISK_META[result.risk] || C.textMuted }}
                >
                  {t("sim.risk.label")}: {t(`sim.risk.${result.risk}`) || result.risk}
                </span>
                <span style={{ color: C.textMuted }}>
                  {t("sim.evidenceLine", { months: result.evidence.monthsCovered, rows: result.evidence.transactions })}
                </span>
              </div>

              <div className="mt-5 p-4 rounded-xl" style={{ background: C.blueSoft }}>
                <div className="text-sm font-medium" style={{ color: C.blue }}>{t("sim.ci90")}</div>
                <div className="tabnum text-sm mt-1" style={{ color: C.charcoal }}>
                  {fmtK(result.impact.estimatedRange.low, locale)} → {fmtK(result.impact.estimatedRange.high, locale)}
                </div>
                <p className="text-xs mt-2" style={{ color: C.textSecondary }}>{result.rangeMethodology}</p>
              </div>

              <button
                onClick={commitAsDecision}
                disabled={committing || committed}
                className="mt-4 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-60"
                style={{ background: committed ? C.green : C.blue, color: C.white }}
              >
                {committing ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
                {committed ? "Added to Decision Log" : "Commit this scenario as a decision"}
              </button>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// Parte 2, FASE 4 — the page now has two tabs: the original sales what-ifs
// ("Negócio") and the stock portfolio's "sell part of a position" scenario
// ("Carteira de ações", PortfolioSellTab.jsx). `businessDataMissing` is set by
// the shell when there are no sales analytics (e.g. an organisation that only
// uses the portfolio): the portfolio tab then opens first, since the business
// one would only show its "no transactions" error.
function DecisionSimulator({ sourceInfo, filters, businessDataMissing = false }) {
  const { t } = useLang();
  const [tab, setTab] = useState(businessDataMissing ? "portfolio" : "business");
  const tabs = [
    { id: "business", label: t("sim.tab.business") },
    { id: "portfolio", label: t("sim.tab.portfolio") },
  ];

  return (
    <div>
      <SectionTitle eyebrow="What happens if I do X?" title="Decision Simulator" desc={tab === "portfolio" ? t("sim.portfolio.desc") : t("sim.desc")} />
      <div role="tablist" aria-label={t("sim.tabs.label")} className="flex gap-1 mt-2 mb-5 border-b" style={{ borderColor: C.greyBorderSoft }}>
        {tabs.map((tb) => (
          <button
            key={tb.id}
            role="tab"
            aria-selected={tab === tb.id}
            onClick={() => setTab(tb.id)}
            className="px-3 py-2 text-sm"
            style={tab === tb.id ? { color: C.blue, borderBottom: `2px solid ${C.blue}`, fontWeight: 600 } : { color: C.textSecondary }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "portfolio" ? (
        <PortfolioSellTab />
      ) : (
        <>
          <SourceBadge sourceInfo={sourceInfo} />
          <BusinessSimulator filters={filters} />
        </>
      )}
    </div>
  );
}

export default DecisionSimulator;
