import React, { useState, useMemo, useEffect } from "react";
import { Sparkles, AlertTriangle, ArrowUpRight, Loader2 } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK, pct } from "../../lib/format";
import { computeAlerts } from "../../lib/metrics";
import { alertCopy } from "../../lib/alertCopy";
import { buildDigest } from "../../lib/digest";
import { apiFetch } from "../../api/client";
import { callClaudeWithTools, ADVISOR_SYSTEM } from "../../api/aiClient";
import { Card, KPI, SectionTitle, SourceBadge, useToast } from "../../components/ui";
import DecisionFeed from "../../components/DecisionFeed";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";

function Overview({ analytics, sourceInfo, execMode, filters }) {
  const { t, lang, locale } = useLang();
  const { totals, deltas, leakage, monthly, byProduct } = analytics;
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const isBackendMode = sourceInfo?.type !== "demo";
  const toast = useToast();

  // P2 "Recommendation -> Decision": turns a detected decision straight
  // into a tracked one in the Decision Log, freezing its evidence at this
  // moment (see components/DecisionFeed.jsx's toDecisionLogPayload).
  const trackDecision = async (payload) => {
    if (!isBackendMode) { toast.error("Connect a real data source to track decisions."); throw new Error("demo mode"); }
    try {
      await apiFetch("/api/decision-log", { method: "POST", body: payload });
      toast.success("Added to Decision Log — review it there to submit for approval.");
    } catch (e) {
      toast.error(e.message || "Could not create the decision");
      throw e;
    }
  };

  // P0 credibility fix: the Decision Feed used to only ever show
  // computeAlerts() (simple KPI-threshold trips, no confidence or
  // evidence). The real Decision Engine — confidence scored from data
  // volume/volatility, every decision carrying its own evidence and
  // drivers — already existed (decisionEngine.js) but was only ever
  // called by the AI Advisor's tools, never by this page. Now it is.
  const [decisions, setDecisions] = useState([]);
  const [dataCoverage, setDataCoverage] = useState(null);
  useEffect(() => {
    if (!isBackendMode) { setDecisions([]); setDataCoverage(null); return; }
    let cancelled = false;
    const qs = new URLSearchParams(filters).toString();
    apiFetch(`/api/decisions?${qs}`)
      .then((data) => { if (!cancelled) { setDecisions(data.decisions || []); setDataCoverage(data.dataCoverage || null); } })
      .catch(() => { if (!cancelled) { setDecisions([]); setDataCoverage(null); } });
    return () => { cancelled = true; };
  }, [isBackendMode, filters]);

  const askAdvisor = async () => {
    if (sourceInfo?.type === "demo") { setErr(t("advisor.needsRealData")); return; }
    setLoading(true); setErr("");
    try {
      const scope = buildDigest(analytics, filters).activeFilters;
      const userText = lang === "pt"
        ? `Gera uma recomendação de negócio para os dados e filtros atuais. Filtros ativos: ${JSON.stringify(scope)}. Usa as ferramentas disponíveis para reunir evidência antes de responderes.`
        : `Generate a business recommendation for the current data and filters. Active filters: ${JSON.stringify(scope)}. Use the available tools to gather evidence before answering.`;
      const text = await callClaudeWithTools(ADVISOR_SYSTEM[lang], userText, { filters });
      // Open-weight models (Llama) often wrap the JSON in a sentence or a
      // markdown fence; take everything from the first "{" to the last "}".
      const raw = text.replace(/```json|```/g, "").trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      const result = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
      setAdvice(result);
    } catch (e) {
      setErr(t("ai.summary.error"));
    } finally { setLoading(false); }
  };

  const pieColors = [C.blue, "#5C93F0", "#8FB4F5", "#BFD4F9", C.greyBorder];
  const dimLabel = (d) => (d === "Produto" ? t("dim.product") : d === "Região" ? t("dim.region") : d === "Canal" ? t("dim.channel") : d);
  const alerts = useMemo(() => computeAlerts(analytics), [analytics]);
  const copyFor = (a) => alertCopy(a, t, locale);

  return (
    <div>
      <SectionTitle eyebrow={t("overview.greeting")} title="Executive Overview" desc={t("overview.desc")} />
      <SourceBadge sourceInfo={sourceInfo} />

      {(decisions.length > 0 || alerts.length > 0) && (
        <div className="mb-6">
          <DecisionFeed decisions={decisions} alerts={decisions.length ? [] : alerts} alertCopy={copyFor} dataCoverage={dataCoverage} onTrackDecision={trackDecision} />
        </div>
      )}

      <div className="flex flex-wrap gap-4 mb-6">
        <KPI label={t("kpi.revenue")} value={fmtK(totals.revenue, locale)} delta={pct(deltas.revenue)} deltaTone={deltas.revenue >= 0 ? "green" : "red"} sub={t("kpi.vsFirstHalf")} />
        <KPI label={t("kpi.netProfit")} value={fmtK(totals.profit, locale)} delta={pct(deltas.profit)} deltaTone={deltas.profit >= 0 ? "green" : "red"} sub={t("kpi.vsFirstHalf")} />
        <KPI label={t("kpi.profitMargin")} value={`${totals.margin.toFixed(1)}%`} delta={`${deltas.marginPP >= 0 ? "+" : ""}${deltas.marginPP.toFixed(1)}pp`} deltaTone={deltas.marginPP >= 0 ? "green" : "red"} />
        <KPI label={t("kpi.rowsAnalyzed")} value={analytics.count.toLocaleString(locale)} sub={t("kpi.transactionsInModel")} />
      </div>

      <Card className="p-6 mb-6" style={{ borderColor: C.blue, background: `linear-gradient(180deg, ${C.blueSoft} 0%, ${C.surface} 55%)` }}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2"><Sparkles size={16} color={C.blue} /><span className="text-sm font-semibold" style={{ color: C.blue }}>{t("ai.summary.title")}</span></div>
          {!advice && !loading && <button onClick={askAdvisor} className="text-xs font-medium px-3 py-1.5 rounded-lg text-white" style={{ background: C.blue }}>{t("ai.summary.generate")}</button>}
          {loading && <span className="flex items-center gap-1.5 text-xs" style={{ color: C.blue }}><Loader2 size={13} className="animate-spin" /> {t("ai.summary.analyzing")}</span>}
        </div>
        {err && <div className="text-sm" style={{ color: C.red }}>{err}</div>}
        {!advice && !loading && !err && (
          <p className="text-[15px] leading-relaxed" style={{ color: C.charcoal }}>
            {leakage[0] ? t("ai.summary.leaderLine", { name: leakage[0].name, dim: dimLabel(leakage[0].dim).toLowerCase() }) : t("ai.summary.noSignal")}{t("ai.summary.cta")}
          </p>
        )}
        {advice && <p className="text-[15px] leading-relaxed" style={{ color: C.charcoal }}>{t("ai.summary.adviceLine", { title: advice.title, lo: advice.upsideLow, hi: advice.upsideHigh })}</p>}
        <div className="mt-4 grid grid-cols-3 gap-3">
          {leakage.map((l) => (
            <div key={l.name} className="rounded-xl p-3" style={{ background: C.surface, border: `1px solid ${C.greyBorder}` }}>
              <div className="text-sm font-medium" style={{ color: C.charcoal }}>{l.name}</div>
              <div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{dimLabel(l.dim)} · {t("leakage.marginWord")} {l.deltaPP.toFixed(1)}pp</div>
              <div className="tabnum mt-2 text-lg font-semibold" style={{ color: C.red }}>{fmtK(l.impact, locale)}</div>
            </div>
          ))}
          {!leakage.length && <div className="text-sm col-span-3" style={{ color: C.textMuted }}>{t("leakage.none")}</div>}
        </div>
      </Card>

      {execMode && (
        <div className="grid grid-cols-3 gap-4">
          <Card className="p-5 col-span-2">
            <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("chart.revVsProfit")}</div>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={monthly}>
                <defs><linearGradient id="rev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={C.blue} stopOpacity={0.25} /><stop offset="100%" stopColor={C.blue} stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid stroke={C.greyBorderSoft} vertical={false} />
                <XAxis dataKey="m" tick={{ fontSize: 12, fill: C.textMuted }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 12, fill: C.textMuted }} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => `${Math.round(v / 1000)}K`} />
                <Tooltip contentStyle={{ borderRadius: 10, border: `1px solid ${C.greyBorder}`, fontSize: 12 }} formatter={(v) => fmtK(v, locale)} />
                <Area type="monotone" dataKey="revenue" stroke={C.blue} strokeWidth={2} fill="url(#rev)" name={t("series.revenue")} />
                <Line type="monotone" dataKey="profit" stroke={C.green} strokeWidth={2} dot={false} name={t("series.profit")} />
              </AreaChart>
            </ResponsiveContainer>
          </Card>
          <Card className="p-5">
            <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("chart.productMix")}</div>
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={byProduct} dataKey="revenue" nameKey="product" innerRadius={55} outerRadius={80} paddingAngle={2}>
                  {byProduct.map((_, i) => <Cell key={i} fill={pieColors[i % pieColors.length]} />)}
                </Pie>
                <Tooltip contentStyle={{ borderRadius: 10, border: `1px solid ${C.greyBorder}`, fontSize: 12 }} formatter={(v) => fmtK(v)} />
              </PieChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}
    </div>
  );
}


export default Overview;
