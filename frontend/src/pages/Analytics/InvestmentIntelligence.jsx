import React, { useState, useMemo } from "react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK, pct } from "../../lib/format";
import { Card, SectionTitle, SourceBadge } from "../../components/ui";

function computeDcfModel(analytics, { wacc, termGrowth, ebitdaMargin, daPct, capexPct, wcPct, taxRate, netDebt, shares, price }) {
  const m = analytics.monthly;
  if (m.length < 2) return null;
  const revenueNow = analytics.totals.revenue / (m.length / 12);
  const first = m[0].revenue || 1, last = m[m.length - 1].revenue || 1;
  const monthlyGrowth = Math.pow(Math.max(last, 1) / Math.max(first, 1), 1 / m.length) - 1;
  let revCagr = (Math.pow(1 + monthlyGrowth, 12) - 1) * 100;
  revCagr = Math.max(-25, Math.min(50, revCagr));

  const years = [];
  let revenue = revenueNow, pvSum = 0, lastFcf = 0;
  for (let y = 1; y <= 5; y++) {
    const growth = (revCagr / 100) * (1 - (y - 1) / 5) + (termGrowth / 100) * ((y - 1) / 5);
    const prevRevenue = revenue;
    revenue = revenue * (1 + growth);
    const ebitda = revenue * (ebitdaMargin / 100);
    const da = revenue * (daPct / 100);
    const ebit = ebitda - da;
    const nopat = ebit * (1 - taxRate / 100);
    const capex = revenue * (capexPct / 100);
    const deltaWc = (revenue - prevRevenue) * (wcPct / 100);
    const fcf = nopat + da - capex - deltaWc;
    const disc = fcf / Math.pow(1 + wacc / 100, y);
    pvSum += disc;
    lastFcf = fcf;
    years.push({ year: y, revenue, ebitda, ebit, nopat, fcf, pv: disc });
  }
  const terminalFcf = lastFcf * (1 + termGrowth / 100);
  const terminalValue = terminalFcf / (wacc / 100 - termGrowth / 100);
  const pvTerminal = terminalValue / Math.pow(1 + wacc / 100, 5);
  const enterpriseValue = pvSum + pvTerminal;
  const equityValue = enterpriseValue - netDebt;
  const fairValue = equityValue / shares;
  return { years, revCagr, enterpriseValue, equityValue, fairValue, upside: ((fairValue - price) / price) * 100 };
}

/* Real DCF structure: Revenue → EBITDA → EBIT → NOPAT → +D&A → −CapEx → −ΔWC → FCF
   → discount @ WACC → Enterprise Value → − Net Debt → Equity Value → ÷ Shares.
   Only revenue and its historical growth rate come from the transaction data —
   a sales-transaction export never contains EBITDA margin, D&A, CapEx, working
   capital or net debt, so those stay as explicit, editable assumptions rather
   than being quietly invented. */
function InvestmentIntelligence({ analytics, sourceInfo }) {
  const { t, locale } = useLang();
  const [wacc, setWacc] = useState(9);
  const [termGrowth, setTermGrowth] = useState(2.5);
  // Not derived from the connected data — a sales-transaction export has no P&L,
  // so this starts at a neutral placeholder the user must consciously set.
  const [ebitdaMargin, setEbitdaMargin] = useState(20);
  const [daPct, setDaPct] = useState(4);
  const [capexPct, setCapexPct] = useState(5);
  const [wcPct, setWcPct] = useState(8);
  const [taxRate, setTaxRate] = useState(21);
  const [netDebt, setNetDebt] = useState(0);
  const [shares, setShares] = useState(10_000_000);
  const [price, setPrice] = useState(27.85);

  const dcfParams = { wacc, termGrowth, ebitdaMargin, daPct, capexPct, wcPct, taxRate, netDebt, shares, price };
  const model = useMemo(() => computeDcfModel(analytics, dcfParams), [analytics, wacc, termGrowth, ebitdaMargin, daPct, capexPct, wcPct, taxRate, netDebt, shares, price]);

  // Sensitivity matrix: fair value per share across a WACC × terminal-growth grid,
  // holding every other assumption at its current value.
  const sensitivity = useMemo(() => {
    if (!model) return null;
    const waccSteps = [wacc - 1, wacc, wacc + 1];
    const growthSteps = [termGrowth - 1, termGrowth, termGrowth + 1];
    return {
      waccSteps, growthSteps,
      rows: waccSteps.map((w) => growthSteps.map((g) => {
        if (w / 100 - g / 100 <= 0.001) return null; // WACC must exceed terminal growth for a finite terminal value
        const r = computeDcfModel(analytics, { ...dcfParams, wacc: w, termGrowth: g });
        return r ? r.fairValue : null;
      })),
    };
  }, [analytics, wacc, termGrowth, ebitdaMargin, daPct, capexPct, wcPct, taxRate, netDebt, shares, price]);

  const Num = ({ label, value, setValue, step = 1 }) => (
    <label className="block">
      <span className="text-xs" style={{ color: C.textSecondary }}>{label}</span>
      <input type="number" value={value} step={step} onChange={(e) => setValue(Number(e.target.value))}
        className="mt-1 w-full px-3 py-2 rounded-lg text-sm tabnum outline-none" style={{ border: `1px solid ${C.greyBorder}` }} />
    </label>
  );

  if (!model) return <div className="text-sm" style={{ color: C.textMuted }}>{t("invest.insufficientData")}</div>;

  return (
    <div>
      <SectionTitle eyebrow="Investment Intelligence" title={t("invest.title")} desc={t("invest.desc")} />
      <SourceBadge sourceInfo={sourceInfo} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card className="p-5"><div className="text-sm" style={{ color: C.textSecondary }}>{t("kpi.fairValue")}</div><div className="tabnum text-3xl font-semibold mt-2" style={{ color: C.charcoal }}>€{model.fairValue.toFixed(2)}</div></Card>
        <Card className="p-5"><div className="text-sm" style={{ color: C.textSecondary }}>{t("kpi.ev")}</div><div className="tabnum text-3xl font-semibold mt-2" style={{ color: C.charcoal }}>{fmtK(model.enterpriseValue, locale)}</div></Card>
        <Card className="p-5" style={{ background: model.upside >= 0 ? C.greenSoft : C.redSoft, borderColor: "transparent" }}>
          <div className="text-sm" style={{ color: model.upside >= 0 ? C.green : C.red }}>{t("kpi.upside")}</div>
          <div className="tabnum text-3xl font-semibold mt-2" style={{ color: model.upside >= 0 ? C.green : C.red }}>{pct(model.upside)}</div>
        </Card>
      </div>

      <Card className="p-5 mb-4 overflow-x-auto">
        <div className="text-sm font-medium mb-3" style={{ color: C.charcoal }}>{t("table.title")}</div>
        <table className="w-full text-sm tabnum">
          <thead><tr style={{ color: C.textSecondary }}>
            <th className="text-left font-medium pb-2">{t("table.year")}</th><th className="text-right font-medium pb-2">{t("table.revenue")}</th>
            <th className="text-right font-medium pb-2">{t("table.ebitda")}</th><th className="text-right font-medium pb-2">{t("table.ebit")}</th>
            <th className="text-right font-medium pb-2">{t("table.nopat")}</th><th className="text-right font-medium pb-2">{t("table.fcf")}</th>
            <th className="text-right font-medium pb-2">{t("table.discountedFcf")}</th>
          </tr></thead>
          <tbody>
            {model.years.map((y) => (
              <tr key={y.year} style={{ borderTop: `1px solid ${C.greyBorderSoft}`, color: C.charcoal }}>
                <td className="py-1.5">{t("table.yearRow", { n: y.year })}</td>
                <td className="text-right">{fmtK(y.revenue, locale)}</td><td className="text-right">{fmtK(y.ebitda, locale)}</td>
                <td className="text-right">{fmtK(y.ebit, locale)}</td><td className="text-right">{fmtK(y.nopat, locale)}</td>
                <td className="text-right">{fmtK(y.fcf, locale)}</td><td className="text-right" style={{ color: C.blue }}>{fmtK(y.pv, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {sensitivity && (
        <Card className="p-5 mb-4 overflow-x-auto">
          <div className="text-sm font-medium" style={{ color: C.charcoal }}>{t("sensitivity.title")}</div>
          <p className="text-xs mt-1 mb-3" style={{ color: C.textMuted }}>{t("sensitivity.desc")}</p>
          <table className="w-full text-sm tabnum">
            <thead>
              <tr>
                <th className="text-left font-medium pb-2 pr-2" style={{ color: C.textSecondary }}>{t("sensitivity.waccVsGrowth")}</th>
                {sensitivity.growthSteps.map((g, i) => (
                  <th key={i} className="text-right font-medium pb-2 px-2" style={{ color: C.textSecondary }}>{g.toFixed(1)}%</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sensitivity.waccSteps.map((w, ri) => (
                <tr key={ri} style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
                  <td className="py-2 pr-2 font-medium" style={{ color: C.textSecondary }}>{w.toFixed(1)}%</td>
                  {sensitivity.rows[ri].map((v, ci) => {
                    const isBase = ri === 1 && ci === 1;
                    return (
                      <td key={ci} className="text-right px-2 py-2 rounded-lg" style={{ color: C.charcoal, background: isBase ? C.blueSoft : "transparent", fontWeight: isBase ? 700 : 400 }}>
                        {v == null ? "—" : `€${v.toFixed(2)}`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card className="p-5 mb-4">
        <div className="text-sm font-medium mb-1" style={{ color: C.charcoal }}>{t("assumptions.title")}</div>
        <p className="text-xs mb-4" style={{ color: C.textMuted }}>
          {t("assumptions.desc", { cagr: model.revCagr.toFixed(1) })}
        </p>
        <div className="grid grid-cols-4 gap-4">
          <Num label={t("field.ebitdaMargin")} value={ebitdaMargin} setValue={setEbitdaMargin} step={1} />
          <Num label={t("field.da")} value={daPct} setValue={setDaPct} step={0.5} />
          <Num label={t("field.capex")} value={capexPct} setValue={setCapexPct} step={0.5} />
          <Num label={t("field.wc")} value={wcPct} setValue={setWcPct} step={1} />
          <Num label={t("field.taxRate")} value={taxRate} setValue={setTaxRate} step={1} />
          <Num label={t("field.wacc")} value={wacc} setValue={setWacc} step={0.5} />
          <Num label={t("field.termGrowth")} value={termGrowth} setValue={setTermGrowth} step={0.5} />
          <Num label={t("field.netDebt")} value={netDebt} setValue={setNetDebt} step={10000} />
          <Num label={t("field.shares")} value={shares} setValue={setShares} step={100000} />
          <Num label={t("field.price")} value={price} setValue={setPrice} step={0.5} />
        </div>
      </Card>
      <div className="text-xs px-3 py-2 rounded-lg w-fit" style={{ background: C.yellowSoft, color: C.yellow }}>
        {t("invest.disclaimer")}
      </div>
    </div>
  );
}


export default InvestmentIntelligence;
export { computeDcfModel };
