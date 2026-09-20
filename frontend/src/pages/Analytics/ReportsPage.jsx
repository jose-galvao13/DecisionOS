import React, { useMemo } from "react";
import {
  Printer, FileText, ShieldAlert, Lightbulb, Users, CalendarClock, GitCompareArrows,
  Package, Globe2, Zap, ArrowUpRight, ArrowDownRight,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { C, chartTooltip, barCursor } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK, pct } from "../../lib/format";
import { computeAlerts } from "../../lib/metrics";
import { alertCopy } from "../../lib/alertCopy";
import { Card, SectionTitle, SourceBadge, EmptyState, Pill } from "../../components/ui";

/* ---------------------------------------------------------------
   Executive report — a printable, one-document view built ONLY from
   what `analytics` already contains (totals, deltas, profit bridge,
   leakage, alerts, products, regions, customers, forecast). No new
   backend call, no LLM: every number here is deterministic and is the
   same number the other pages show.

   Print behaviour lives in theme.jsx (`@media print`): the sidebar,
   header, filter bar and chat widget are hidden, the report sheet
   becomes the page, and the theme is forced to light so a PDF is
   readable no matter which theme is active on screen.
----------------------------------------------------------------*/

const signedK = (v, locale) => `${v >= 0 ? "+" : "−"}${fmtK(Math.abs(v), locale)}`;
const signedPct = (v, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}`;

const toDate = (d) => {
  const x = d ? new Date(d) : null;
  return x && !Number.isNaN(x.getTime()) ? x : null;
};

function Section({ icon: Icon, title, children, className = "" }) {
  return (
    <section className={`report-section ${className}`}>
      <div className="flex items-center gap-2 mb-3">
        <Icon size={15} color={C.blue} />
        <h2 className="text-sm font-semibold" style={{ color: C.charcoal }}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, delta, tone, sub }) {
  const color = tone === "green" ? C.green : tone === "red" ? C.red : C.textSecondary;
  const Arrow = tone === "red" ? ArrowDownRight : ArrowUpRight;
  return (
    <div className="rounded-xl p-4" style={{ background: C.greyBg, border: `1px solid ${C.greyBorderSoft}` }}>
      <div className="text-xs" style={{ color: C.textSecondary }}>{label}</div>
      <div className="tabnum text-2xl font-semibold mt-1" style={{ color: C.charcoal }}>{value}</div>
      <div className="mt-1 flex items-center gap-1 text-xs min-h-[16px]" style={{ color }}>
        {delta != null && <><Arrow size={12} />{delta}</>}
        {sub && <span style={{ color: C.textMuted }}>{sub}</span>}
      </div>
    </div>
  );
}

function FindingRow({ tone, title, line }) {
  const color = tone === "red" ? C.red : tone === "yellow" ? C.yellow : C.green;
  return (
    <li className="flex gap-3 py-2.5" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
      <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
      <div className="min-w-0">
        {title && <div className="text-sm font-medium" style={{ color: C.charcoal }}>{title}</div>}
        <div className="text-sm" style={{ color: C.textSecondary }}>{line}</div>
      </div>
    </li>
  );
}

function BarRow({ label, value, share, note }) {
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between text-sm mb-1">
        <span style={{ color: C.charcoal }}>{label}</span>
        <span className="tabnum" style={{ color: C.textSecondary }}>{value}</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: C.greyBorderSoft }}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(2, Math.min(100, share))}%`, background: C.blue }} />
      </div>
      {note && <div className="text-xs mt-0.5" style={{ color: C.textMuted }}>{note}</div>}
    </div>
  );
}

function ProfitBridge({ bridge, t, locale }) {
  const rows = [
    { key: "bridge.volume", v: bridge.volumeEffect },
    { key: "bridge.price", v: bridge.priceEffect },
    { key: "bridge.discount", v: bridge.discountEffect },
    { key: "bridge.cost", v: bridge.costEffect },
    { key: "bridge.mix", v: bridge.mixEffect },
  ].filter((r) => Number.isFinite(r.v));
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.v)));
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-2" style={{ color: C.textSecondary }}>
        <span>{t("bridge.start")}: <b className="tabnum" style={{ color: C.charcoal }}>{fmtK(bridge.profit1, locale)}</b></span>
        <span>{t("bridge.end")}: <b className="tabnum" style={{ color: C.charcoal }}>{fmtK(bridge.profit2, locale)}</b></span>
      </div>
      {rows.map((r) => {
        const w = (Math.abs(r.v) / max) * 50;
        const good = r.v >= 0;
        return (
          <div key={r.key} className="flex items-center gap-3 py-1.5 text-sm">
            <span className="w-28 shrink-0" style={{ color: C.textSecondary }}>{t(r.key)}</span>
            <div className="relative flex-1 h-4">
              <div className="absolute top-0 bottom-0 left-1/2 w-px" style={{ background: C.greyBorder }} />
              <div
                className="absolute top-0.5 bottom-0.5 rounded-sm"
                style={{ width: `${w}%`, [good ? "left" : "right"]: "50%", background: good ? C.green : C.red, opacity: 0.85 }}
              />
            </div>
            <span className="tabnum w-20 text-right shrink-0" style={{ color: good ? C.green : C.red }}>{signedK(r.v, locale)}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function ReportsPage({ analytics, sourceInfo }) {
  const { t, locale } = useLang();

  const alerts = useMemo(() => (analytics ? computeAlerts(analytics) : []), [analytics]);

  if (!analytics) {
    return (
      <div>
        <SectionTitle eyebrow={t("nav.reports")} title={t("reports.title")} desc={t("reports.desc")} />
        <EmptyState icon={FileText} desc={t("common.noData")} />
      </div>
    );
  }

  const { totals, deltas, monthly, byProduct = [], byRegion = [], byChannel = [], leakage = [], profitBridge, forecast } = analytics;
  const ci = analytics.customerIntelligence;

  /* ---- masthead / narrative ---- */
  const from = toDate(analytics.dateRange?.min);
  const to = toDate(analytics.dateRange?.max);
  const dateFmt = { day: "numeric", month: "short", year: "numeric" };
  const generatedOn = new Date().toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
  const sourceName = sourceInfo?.type === "demo" ? t("header.demoData") : sourceInfo?.name;

  const baseVars = { revenue: fmtK(totals.revenue, locale), profit: fmtK(totals.profit, locale), margin: `${totals.margin.toFixed(1)}%` };
  const narrative = deltas
    ? t("reports.narrative", { ...baseVars, revDelta: pct(deltas.revenue), profitDelta: pct(deltas.profit), marginPP: `${signedPct(deltas.marginPP)}pp` })
    : t("reports.narrativeNoDelta", baseVars);

  /* ---- risks & opportunities (deterministic: alerts + leakage + best product) ---- */
  const dimLabel = (d) => (d === "Produto" ? t("dim.product") : d === "Região" ? t("dim.region") : d === "Canal" ? t("dim.channel") : d);
  const risks = alerts.filter((a) => a.tone !== "green").map((a) => ({ tone: a.tone, leakName: a.type === "margin" ? a.name : null, ...alertCopy(a, t, locale) }));
  const marginAlertName = risks.find((r) => r.leakName)?.leakName;
  const extraLeaks = leakage.slice(0, 3).filter((l) => l.name !== marginAlertName).map((l) => ({
    tone: "red", title: null,
    line: t("reports.leakLine", {
      name: l.name, dim: dimLabel(l.dim).toLowerCase(),
      before: l.marginBefore.toFixed(1), after: l.marginAfter.toFixed(1), impact: signedK(l.impact, locale),
    }),
  }));
  const allRisks = [...risks, ...extraLeaks];

  const opportunities = alerts.filter((a) => a.tone === "green").map((a) => ({ tone: "green", ...alertCopy(a, t, locale) }));
  const best = analytics.bestProducts?.[0];
  if (best) opportunities.push({ tone: "green", title: null, line: t("reports.bestProductLine", { product: best.product, margin: best.margin.toFixed(1) }) });

  /* ---- breakdowns ---- */
  const topProducts = byProduct.slice(0, 5);
  const regions = byRegion.slice(0, 5);
  const regionMax = regions[0]?.value || 1;
  const hasChannels = byChannel.some((c) => c.channel && c.channel !== "N/D");
  const channels = byChannel.slice(0, 5);
  const channelMax = channels[0]?.revenue || 1;
  const share = (v) => (totals.revenue ? (v / totals.revenue) * 100 : 0);
  const chartData = (monthly || []).map((m) => ({ m: m.m, [t("series.revenue")]: Math.round(m.revenue), [t("series.profit")]: Math.round(m.profit) }));

  return (
    <div className="max-w-5xl mx-auto">
      {/* ---------- on-screen chrome (hidden when printing) ---------- */}
      <div className="no-print">
        <div className="flex items-start justify-between gap-4">
          <SectionTitle eyebrow={t("nav.reports")} title={t("reports.title")} desc={t("reports.desc")} />
          <button
            onClick={() => window.print()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium shrink-0"
            style={{ background: C.blue, color: C.white }}
          >
            <Printer size={14} /> {t("reports.print")}
          </button>
        </div>
        <SourceBadge sourceInfo={sourceInfo} />
      </div>

      {/* ---------- the report sheet ---------- */}
      <Card className="report-sheet p-8">
        <header className="flex items-start justify-between gap-6 pb-6 mb-6" style={{ borderBottom: `1px solid ${C.greyBorder}` }}>
          <div>
            <div className="flex items-center gap-2 mb-3">
              <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: C.blue }}><Zap size={13} color="white" /></div>
              <span className="text-sm font-semibold" style={{ color: C.charcoal }}>DecisionOS</span>
            </div>
            <h1 className="text-2xl font-semibold" style={{ color: C.charcoal }}>{t("reports.executiveSummary")}</h1>
            {sourceName && <div className="text-sm mt-1" style={{ color: C.textSecondary }}>{sourceName}</div>}
          </div>
          <div className="text-right text-xs space-y-1" style={{ color: C.textSecondary }}>
            {from && to && (
              <div>
                <span style={{ color: C.textMuted }}>{t("reports.period")}: </span>
                {t("reports.periodValue", { from: from.toLocaleDateString(locale, dateFmt), to: to.toLocaleDateString(locale, dateFmt) })}
              </div>
            )}
            <div>{t("kpi.rowsAnalyzed")}: <span className="tabnum">{analytics.count.toLocaleString(locale)}</span></div>
            <div style={{ color: C.textMuted }}>{t("reports.generatedOn", { date: generatedOn })}</div>
          </div>
        </header>

        {/* headline + KPIs */}
        <section className="report-section mb-8">
          <p className="text-[15px] leading-relaxed mb-5" style={{ color: C.charcoal }}>{narrative}</p>
          <div className="grid grid-cols-4 gap-3">
            <Stat label={t("kpi.revenue")} value={fmtK(totals.revenue, locale)} delta={deltas ? pct(deltas.revenue) : null} tone={deltas && deltas.revenue < 0 ? "red" : "green"} sub={deltas ? t("kpi.vsFirstHalf") : null} />
            <Stat label={t("kpi.profit")} value={fmtK(totals.profit, locale)} delta={deltas ? pct(deltas.profit) : null} tone={deltas && deltas.profit < 0 ? "red" : "green"} sub={deltas ? t("kpi.vsFirstHalf") : null} />
            <Stat label={t("kpi.margin")} value={`${totals.margin.toFixed(1)}%`} delta={deltas ? `${signedPct(deltas.marginPP)}pp` : null} tone={deltas && deltas.marginPP < 0 ? "red" : "green"} />
            <Stat label={t("kpi.transactions")} value={analytics.count.toLocaleString(locale)} sub={t("kpi.transactionsInModel")} />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-8 mb-8">
          <Section icon={ShieldAlert} title={t("reports.topRisks")}>
            {allRisks.length ? (
              <ul>{allRisks.map((r, i) => <FindingRow key={i} tone={r.tone} title={r.title} line={r.line} />)}</ul>
            ) : <p className="text-sm" style={{ color: C.textMuted }}>{t("reports.noRisks")}</p>}
          </Section>
          <Section icon={Lightbulb} title={t("reports.topOpportunities")}>
            {opportunities.length ? (
              <ul>{opportunities.map((r, i) => <FindingRow key={i} tone={r.tone} title={r.title} line={r.line} />)}</ul>
            ) : <p className="text-sm" style={{ color: C.textMuted }}>{t("reports.noOpportunities")}</p>}
          </Section>
        </div>

        <div className="grid grid-cols-2 gap-8 mb-8">
          <Section icon={GitCompareArrows} title={t("reports.whatsChanging")}>
            {profitBridge ? (
              <>
                <ProfitBridge bridge={profitBridge} t={t} locale={locale} />
                <p className="text-xs mt-2" style={{ color: C.textMuted }}>{t("bridge.desc")}</p>
              </>
            ) : <p className="text-sm" style={{ color: C.textMuted }}>{t("invest.insufficientData")}</p>}
          </Section>
          <Section icon={FileText} title={t("chart.revVsProfit")}>
            <ResponsiveContainer width="100%" height={210}>
              <BarChart data={chartData} barGap={2}>
                <CartesianGrid stroke={C.greyBorderSoft} vertical={false} />
                <XAxis dataKey="m" tick={{ fontSize: 11, fill: C.textMuted }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: C.textMuted }} axisLine={false} tickLine={false} width={38} tickFormatter={(v) => `${Math.round(v / 1000)}K`} />
                <Tooltip {...chartTooltip} cursor={barCursor} formatter={(v) => fmtK(v, locale)} />
                <Bar dataKey={t("series.revenue")} fill={C.blue} radius={[3, 3, 0, 0]} isAnimationActive={false} />
                <Bar dataKey={t("series.profit")} fill={C.green} radius={[3, 3, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </Section>
        </div>

        {topProducts.length > 0 && (
          <Section icon={Package} title={t("reports.topProducts")} className="mb-8">
            <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.greyBorder}` }}>
              <div className="grid grid-cols-5 gap-2 px-4 py-2 text-xs font-semibold" style={{ background: C.greyBg, color: C.textSecondary }}>
                <div>{t("dim.product")}</div>
                <div className="text-right">{t("kpi.revenue")}</div>
                <div className="text-right">{t("kpi.profit")}</div>
                <div className="text-right">{t("kpi.margin")}</div>
                <div className="text-right">{t("products.shareOfRevenue")}</div>
              </div>
              {topProducts.map((p) => {
                const margin = p.margin ?? (p.revenue ? (p.profit / p.revenue) * 100 : 0);
                return (
                  <div key={p.product} className="grid grid-cols-5 gap-2 px-4 py-2.5 text-sm items-center" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
                    <div className="truncate" style={{ color: C.charcoal }}>{p.product}</div>
                    <div className="text-right tabnum" style={{ color: C.charcoal }}>{fmtK(p.revenue, locale)}</div>
                    <div className="text-right tabnum" style={{ color: C.charcoal }}>{fmtK(p.profit, locale)}</div>
                    <div className="text-right tabnum" style={{ color: margin < 15 ? C.red : C.green }}>{margin.toFixed(1)}%</div>
                    <div className="text-right tabnum" style={{ color: C.textSecondary }}>{share(p.revenue).toFixed(1)}%</div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {(regions.length > 0 || hasChannels) && (
          <div className={`grid gap-8 mb-8 ${regions.length > 0 && hasChannels ? "grid-cols-2" : "grid-cols-1"}`}>
            {regions.length > 0 && (
              <Section icon={Globe2} title={t("chart.revByRegion")}>
                {regions.map((r) => (
                  <BarRow key={r.region} label={r.region} value={fmtK(r.value, locale)} share={(r.value / regionMax) * 100} note={`${share(r.value).toFixed(1)}%`} />
                ))}
              </Section>
            )}
            {hasChannels && (
              <Section icon={Globe2} title={t("reports.byChannel")}>
                {channels.map((c) => (
                  <BarRow key={c.channel} label={c.channel} value={fmtK(c.revenue, locale)} share={(c.revenue / channelMax) * 100} note={`${t("kpi.margin")} ${c.margin.toFixed(1)}%`} />
                ))}
              </Section>
            )}
          </div>
        )}

        {ci && (
          <Section icon={Users} title={t("reports.customers")} className="mb-8">
            <div className="grid grid-cols-4 gap-3">
              <Stat label={t("customers.total")} value={ci.total.toLocaleString(locale)} />
              <Stat label={t("customers.atRisk")} value={ci.counts.atRisk} tone={ci.counts.atRisk > 0 ? "red" : "green"} />
              <Stat label={t("kpi.churnRate")} value={`${analytics.churnRate.toFixed(1)}%`} tone={analytics.churnRate >= 15 ? "red" : "green"} />
              <Stat label={t("customers.concentration")} value={`${ci.concentrationPct.toFixed(1)}%`} />
            </div>
          </Section>
        )}

        {forecast && forecast.months?.length > 0 && (
          <Section icon={CalendarClock} title={t("forecast.title")} className="mb-8">
            <div className="flex flex-wrap items-center gap-3 mb-3">
              <p className="text-sm" style={{ color: C.charcoal }}>
                {t("reports.forecastLine", { value: fmtK(forecast.months.reduce((a, m) => a + m.revenue.base, 0), locale) })}
              </p>
              <Pill tone={forecast.confidence === "high" ? "green" : forecast.confidence === "medium" ? "yellow" : "red"}>
                {t("advisor.confidence")}: {t(`forecast.confidence.${forecast.confidence}`)}
              </Pill>
            </div>
            <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.greyBorder}` }}>
              <div className="grid grid-cols-4 gap-2 px-4 py-2 text-xs font-semibold" style={{ background: C.greyBg, color: C.textSecondary }}>
                <div />
                <div className="text-right">{t("forecast.downside")}</div>
                <div className="text-right">{t("forecast.base")}</div>
                <div className="text-right">{t("forecast.upside")}</div>
              </div>
              {forecast.months.map((m) => (
                <div key={m.h} className="grid grid-cols-4 gap-2 px-4 py-2.5 text-sm items-center" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
                  <div style={{ color: C.textSecondary }}>{t("forecast.month", { n: m.h })}</div>
                  <div className="text-right tabnum" style={{ color: C.textSecondary }}>{fmtK(m.revenue.downside, locale)}</div>
                  <div className="text-right tabnum font-medium" style={{ color: C.charcoal }}>{fmtK(m.revenue.base, locale)}</div>
                  <div className="text-right tabnum" style={{ color: C.textSecondary }}>{fmtK(m.revenue.upside, locale)}</div>
                </div>
              ))}
            </div>
            <p className="text-xs mt-2" style={{ color: C.textMuted }}>{t("forecast.desc")}</p>
          </Section>
        )}

        <footer className="pt-5 text-xs" style={{ borderTop: `1px solid ${C.greyBorder}`, color: C.textMuted }}>
          {t("reports.footer")}
        </footer>
      </Card>
    </div>
  );
}
