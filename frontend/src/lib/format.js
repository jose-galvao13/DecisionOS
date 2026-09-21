const fmtK = (v, locale = "pt-PT") => {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `€${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `€${(v / 1_000).toFixed(1)}K`;
  return `€${Math.round(v).toLocaleString(locale)}`;
};
const fmtSigned = (v, unit = "€", locale = "pt-PT") => `${v >= 0 ? "+" : ""}${unit === "€" ? fmtK(v, locale).replace("€", "€") : v.toFixed(1) + unit}`;
const pct = (v, d = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`;

/** "há 5 minutos" / "5 minutes ago" — falls back to the plain date after a month
 *  (a relative time that big says less than the date itself). */
const timeAgo = (value, locale = "pt-PT", now = Date.now()) => {
  const ts = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ts)) return "";
  const diff = Math.round((ts - now) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (abs < 60) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.trunc(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.trunc(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.trunc(diff / 86400), "day");
  return new Date(ts).toLocaleDateString(locale);
};

export { fmtK, fmtSigned, pct, timeAgo };
