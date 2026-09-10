import React, { useState } from "react";
import { AlertTriangle, ArrowUpRight, TrendingDown, Users, Sparkles, ChevronDown, ShieldCheck } from "lucide-react";
import { C, tint } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { Card } from "./ui";

/* ---------------------------------------------------------------
   DECISION FEED — the thing that should make DecisionOS feel like a
   decision system and not "just another dashboard".

   P0 credibility fix: `decisions` (from GET /api/decisions, backed by
   decisionEngine.js) now render their real confidence score, their
   evidence (transaction/month count backing the number), and an
   expandable "how was this calculated" panel built from the engine's
   own `drivers`/`recommendation`/`decision` fields — nothing here is
   invented in the frontend. The lighter-weight `alerts` (simple
   KPI-threshold trips, lib/metrics.js's computeAlerts — no confidence
   or evidence attached) are still supported as a fallback for when
   there isn't enough data for the real Decision Engine to fire yet,
   but are visually distinct (no confidence pill) so they're never
   confused with an evidence-backed decision.
----------------------------------------------------------------*/

const TONE_META = {
  red: { emoji: "🔴", color: C.red, bg: C.redSoft, Icon: AlertTriangle },
  yellow: { emoji: "🟡", color: C.yellow, bg: C.yellowSoft, Icon: Users },
  green: { emoji: "🟢", color: C.green, bg: C.greenSoft, Icon: ArrowUpRight },
};

function ConfidencePill({ confidence }) {
  const color = confidence >= 70 ? C.green : confidence >= 40 ? C.yellow : C.red;
  return (
    <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded" style={{ background: tint(color), color }}>
      {confidence}% confidence
    </span>
  );
}

/** decision from decisionEngine.js -> a POST /api/decision-log body,
 *  freezing its evidence/drivers/confidence at the moment it's turned into
 *  a tracked decision (P2 "Recommendation -> Decision" link). */
function toDecisionLogPayload(decision, measurementWindowDays) {
  return {
    title: decision.title,
    description: decision.decision,
    recommendation: decision.recommendation,
    sourceType: decision.type,
    confidence: decision.confidence,
    sourceSnapshot: { evidence: decision.evidence, drivers: decision.drivers, period: decision.period, affectedEntities: decision.affectedEntities },
    expectedImpact: decision.impact,
    measurementWindowDays,
  };
}

/** A decision from decisionEngine.js: confidence + evidence + drivers,
 *  every number traceable back to this org's own analytics. Expandable to
 *  show its full "how was this calculated" methodology. */
function RichDecisionRow({ decision, onTrackDecision }) {
  const [open, setOpen] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [tracked, setTracked] = useState(false);
  const [windowDays, setWindowDays] = useState(60);
  const meta = TONE_META[decision.severity] || TONE_META.yellow;
  const { Icon } = meta;

  const handleTrack = async (e) => {
    e.stopPropagation();
    if (!onTrackDecision || tracking || tracked) return;
    setTracking(true);
    try {
      await onTrackDecision(toDecisionLogPayload(decision, windowDays));
      setTracked(true);
    } finally {
      setTracking(false);
    }
  };

  return (
    <div className="py-3 px-1" style={{ borderBottom: `1px solid ${C.greyBorderSoft}` }}>
      <button className="w-full flex items-start gap-3 text-left" onClick={() => setOpen((o) => !o)}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: meta.bg }}>
          <Icon size={15} color={meta.color} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: meta.color }}>{meta.emoji} {decision.title}</span>
            <ConfidencePill confidence={decision.confidence} />
          </div>
          <div className="text-sm mt-0.5" style={{ color: C.charcoal }}>{decision.decision}</div>
          <div className="text-xs mt-1" style={{ color: C.textMuted }}>{decision.evidence?.description}</div>
        </div>
        <ChevronDown size={16} color={C.textMuted} className="mt-1 shrink-0 transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className="mt-2 ml-11 p-3 rounded-lg text-sm space-y-2" style={{ background: C.greyBg }}>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: C.textMuted }}>Why</div>
            <ul className="list-disc list-inside space-y-0.5" style={{ color: C.charcoal }}>
              {(decision.drivers || []).map((d, i) => <li key={i}>{d}</li>)}
            </ul>
          </div>
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: C.textMuted }}>Recommendation</div>
            <div style={{ color: C.charcoal }}>{decision.recommendation}</div>
          </div>
          {decision.impact && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: C.textMuted }}>Estimated impact</div>
              <div style={{ color: C.charcoal }}>
                {decision.impact.low === decision.impact.high
                  ? `${decision.impact.currency} ${decision.impact.low.toLocaleString()}`
                  : `${decision.impact.currency} ${decision.impact.low.toLocaleString()} – ${decision.impact.high.toLocaleString()}`}
                {" "}({decision.impact.metric})
              </div>
            </div>
          )}
          <div className="text-xs pt-1" style={{ color: C.textMuted, borderTop: `1px solid ${C.greyBorder}` }}>
            Period analyzed: {decision.period?.from} → {decision.period?.to}
          </div>
          {onTrackDecision && (
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <button
                onClick={handleTrack}
                disabled={tracking || tracked}
                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-60"
                style={{ background: tracked ? C.green : C.blue }}
              >
                {tracked ? "✓ Added to Decision Log" : tracking ? "Adding…" : "Turn into a decision"}
              </button>
              {!tracked && decision.impact && (
                <label className="flex items-center gap-1.5 text-xs" style={{ color: C.textMuted }} onClick={(e) => e.stopPropagation()}>
                  Measure automatically after
                  <input
                    type="number" min="7" max="365" value={windowDays}
                    onChange={(e) => setWindowDays(Number(e.target.value) || 60)}
                    className="w-14 px-1.5 py-0.5 rounded tabnum text-center"
                    style={{ border: `1px solid ${C.greyBorder}` }}
                  />
                  days
                </label>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DecisionRow({ alert, copy }) {
  const meta = TONE_META[alert.tone] || TONE_META.yellow;
  const { Icon } = meta;
  return (
    <div
      className="flex items-start gap-3 py-3 px-1"
      style={{ borderBottom: `1px solid ${C.greyBorderSoft}` }}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: meta.bg }}
      >
        <Icon size={15} color={meta.color} />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold" style={{ color: meta.color }}>
          {meta.emoji} {copy.title}
        </div>
        <div className="text-sm mt-0.5" style={{ color: C.charcoal }}>
          {copy.line}
        </div>
      </div>
    </div>
  );
}

export default function DecisionFeed({ alerts = [], alertCopy, decisions = [], title, emptyLabel, dataCoverage, onTrackDecision }) {
  const { t } = useLang();
  const heading = title || t("decisionFeed.title") || "Decisions";
  const empty = emptyLabel || t("decisionFeed.empty") || "No open decisions right now.";

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-1 px-1">
        <div className="flex items-center gap-2">
          <Sparkles size={14} color={C.blue} />
          <div className="text-xs font-semibold tracking-wide uppercase" style={{ color: C.textSecondary }}>
            {heading}
          </div>
        </div>
        {dataCoverage && dataCoverage.transactions > 0 && (
          <div className="flex items-center gap-1 text-[11px]" style={{ color: C.textMuted }}>
            <ShieldCheck size={12} />
            {dataCoverage.transactions.toLocaleString()} transactions · {dataCoverage.monthsCovered} months
          </div>
        )}
      </div>

      {alerts.length === 0 && decisions.length === 0 && (
        <div className="text-sm px-1 py-3" style={{ color: C.textMuted }}>
          {empty}
        </div>
      )}

      {decisions.map((d) => (
        <RichDecisionRow key={d.id} decision={d} onTrackDecision={onTrackDecision} />
      ))}

      {alerts.map((a, i) => (
        <DecisionRow key={`alert-${i}`} alert={a} copy={alertCopy(a)} />
      ))}
    </Card>
  );
}

export { DecisionRow };
