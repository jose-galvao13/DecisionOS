const fmtK = (v, locale = "pt-PT") => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `€${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `€${(v / 1_000).toFixed(1)}K`;
  return `€${Math.round(v).toLocaleString(locale)}`;
};
const fmtSigned = (v, unit = "€", locale = "pt-PT") => `${v >= 0 ? "+" : ""}${unit === "€" ? fmtK(v, locale).replace("€", "€") : v.toFixed(1) + unit}`;
const pct = (v, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;

export { fmtK, fmtSigned, pct };
