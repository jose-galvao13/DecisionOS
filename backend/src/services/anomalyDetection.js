/* ---------------------------------------------------------------
   ANOMALY DETECTION — shared by the Decision Engine's "Sales
   anomaly" / "Forecast deviation" primitives (FASE 3) and the AI
   Advisor's find_anomalies tool (FASE 5). One implementation, so a
   decision on the feed and an answer from the Advisor about the
   same month can never disagree.

   Method: fit an ordinary-least-squares trend line across the
   monthly series, then flag any month whose actual value sits more
   than `zThreshold` standard deviations (of the fit's own residuals)
   away from what the trend predicted for that month. This is the
   same trend model computeForecast() in analyticsEngine.js already
   uses for the Forecast tab, so "the forecast" and "what's anomalous
   relative to it" are the exact same line.
----------------------------------------------------------------*/

function linreg(ys) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - xMean) * (ys[i] - yMean); den += (xs[i] - xMean) ** 2; }
  const slope = den ? num / den : 0;
  const intercept = yMean - slope * xMean;
  const residuals = ys.map((y, i) => y - (intercept + slope * xs[i]));
  const rmse = Math.sqrt(residuals.reduce((a, r) => a + r * r, 0) / n);
  return { slope, intercept, rmse, mean: yMean, residuals };
}

/** monthly: analytics.monthly (needs at least 4 points to say anything
 *  meaningful about a trend). field: 'revenue' | 'profit'.
 *  Returns [] (not an error) when there isn't enough history — an empty
 *  list here means "nothing flagged", not "nothing checked". */
export function findAnomalies(monthly, field = "revenue", { zThreshold = 1.8 } = {}) {
  if (!monthly || monthly.length < 4) return [];
  const ys = monthly.map((m) => m[field]);
  const { slope, intercept, rmse, residuals } = linreg(ys);
  if (!rmse) return []; // perfectly linear series — nothing to flag

  const out = [];
  monthly.forEach((m, i) => {
    const expected = intercept + slope * i;
    const z = residuals[i] / rmse;
    if (Math.abs(z) >= zThreshold) {
      const deviationPct = expected ? ((m[field] - expected) / Math.abs(expected)) * 100 : null;
      out.push({
        month: m.key,
        label: m.m,
        actual: Math.round(m[field]),
        expected: Math.round(expected),
        deviationPct: deviationPct == null ? null : Number(deviationPct.toFixed(1)),
        z: Number(z.toFixed(2)),
        direction: z > 0 ? "above_trend" : "below_trend",
      });
    }
  });
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}

/** In-sample deviation of the most recent month vs. what the trend fit
 *  (built from ALL months, including that one) expected for it — used by
 *  the "Forecast deviation" decision primitive to flag a recent break in
 *  momentum. Not a true holdout test (the last point influences its own
 *  expected value), which is why this is framed as "momentum shift", not
 *  "forecast error" — a real backtested error would need to refit
 *  excluding the last point, future work. */
export function latestMonthDeviation(monthly, field = "revenue") {
  if (!monthly || monthly.length < 4) return null;
  const ys = monthly.map((m) => m[field]);
  const { slope, intercept, rmse } = linreg(ys);
  if (!rmse) return null;
  const lastIdx = monthly.length - 1;
  const expected = intercept + slope * lastIdx;
  const actual = ys[lastIdx];
  const z = (actual - expected) / rmse;
  const deviationPct = expected ? ((actual - expected) / Math.abs(expected)) * 100 : null;
  return {
    month: monthly[lastIdx].key,
    actual: Math.round(actual),
    expected: Math.round(expected),
    deviationPct: deviationPct == null ? null : Number(deviationPct.toFixed(1)),
    z: Number(z.toFixed(2)),
  };
}
