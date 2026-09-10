/** Excel's epoch (serial day 0) — used when SheetJS hands us a raw serial
 *  number instead of a Date because the source cell wasn't formatted as a
 *  date. */
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Best-effort conversion of a raw cell value into an ISO 'YYYY-MM-DD' date
 *  string, or null if it can't be parsed. Handles: JS Date objects (SheetJS
 *  with cellDates:true), Excel serial numbers, and common string formats. */
export function parseDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date && !isNaN(value)) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && isFinite(value)) {
    const ms = EXCEL_EPOCH + value * 86400000;
    const d = new Date(ms);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    // dd/mm/yyyy or dd-mm-yyyy (common in PT exports)
    const eu = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (eu) {
      let [, d, m, y] = eu;
      if (y.length === 2) y = `20${y}`;
      const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
      return isNaN(date) ? null : date.toISOString().slice(0, 10);
    }
    const date = new Date(s);
    return isNaN(date) ? null : date.toISOString().slice(0, 10);
  }
  return null;
}

/** Best-effort numeric parse: strips currency symbols, thousands separators
 *  (both '1,234.56' and '1.234,56' styles), returns null if not a number. */
export function parseNumber(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  let s = value.trim().replace(/[€$£\s]/g, "");
  if (!s) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // whichever separator comes last is the decimal point
    s = s.lastIndexOf(",") > s.lastIndexOf(".")
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return isFinite(n) ? n : null;
}

/** Normalizes a dimension key (customer/product/region/channel name) for
 *  de-dup: trims and lowercases so "Acme Ltd" and "acme ltd " collide. */
export function normalizeKey(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.toLowerCase() : null;
}
