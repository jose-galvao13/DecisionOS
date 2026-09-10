// FASE 2 — DATA PROFILING (ponto 7 do documento de arquitetura)
//
// Não decide *significado* (isso é semanticTypes.js). Só olha para os
// valores crus de uma coluna e produz factos: tipo primitivo, nulls,
// cardinalidade, estatísticas, amostras. Estes factos são depois o
// "valueScore"/"typeScore"/"distributionScore" de que a deteção semântica
// precisa — sem isto, a deteção semântica ficaria reduzida a olhar só para
// o nome da coluna, que é exatamente o problema que o documento aponta.
import { parseDate, parseNumber } from "../utils/parse.js";

const EU_DATE_RE = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;

// parseDate() will happily interpret ANY number as an Excel serial date
// (5 -> "1900-01-05"), because a serial number is valid for almost any
// input. That's correct when the column genuinely holds date serials, but
// it wrongly flags plain quantity/price columns (small integers/decimals)
// as dates too. So for numeric raw values we only count it as a date hit
// when the resulting serial falls in a plausible business-date range
// (roughly 1980-2100) — small numbers like "5" or "19.99" fall well
// outside that and are left as numeric.
const SERIAL_MIN = 29221; // 1980-01-01
const SERIAL_MAX = 73050; // 2100-01-01
// V8's `new Date(str)` fallback parser is dangerously lenient — e.g.
// `new Date("SKU-1")` returns a valid 2001-01-01 date. parseDate() in
// utils/parse.js relies on that fallback (fine for columns already known
// to be dates during import), but profiling must not let it misclassify
// an arbitrary ID/SKU string as a date. So for strings we only trust
// recognisable date shapes, never the open-ended `new Date()` fallback.
const ISO_LIKE_RE = /^\d{4}-\d{1,2}-\d{1,2}([ T]\d{1,2}:\d{2})?/;
function looksLikeDateString(s) {
  const trimmed = s.trim();
  if (EU_DATE_RE.test(trimmed)) return true;
  if (ISO_LIKE_RE.test(trimmed)) return true;
  return false;
}

function isPlausibleDateHit(rawValue) {
  if (rawValue instanceof Date) return !isNaN(rawValue);
  if (typeof rawValue === "number") return rawValue >= SERIAL_MIN && rawValue <= SERIAL_MAX;
  if (typeof rawValue === "string") return looksLikeDateString(rawValue);
  return false;
}

function detectDateFormat(rawSamples) {
  for (const v of rawSamples) {
    if (v instanceof Date) return "excel-native";
    if (typeof v === "string") {
      if (EU_DATE_RE.test(v.trim())) return "DD/MM/YYYY";
      if (ISO_DATE_RE.test(v.trim())) return "YYYY-MM-DD";
    }
  }
  return null;
}

/**
 * Profile a single column.
 * @param {string} header raw header name
 * @param {Array} rawValues every raw cell value for this column, in row order
 */
export function profileColumn(header, rawValues) {
  const n = rawValues.length;
  const nonNull = rawValues.filter((v) => v !== null && v !== undefined && v !== "");
  const nulls = n - nonNull.length;
  const nullRatio = n ? nulls / n : 0;

  const uniqueSet = new Set(nonNull.map((v) => (v instanceof Date ? v.getTime() : v)));
  const uniqueRatio = nonNull.length ? uniqueSet.size / nonNull.length : 0;

  // Try each primitive interpretation against every non-null value and see
  // which one has the highest hit rate. This is what lets "123,50" or a
  // European "31/12/2025" be recognised as numeric/date even though
  // typeof === "string".
  let numericHits = 0;
  let dateHits = 0;
  const numericValues = [];
  for (const v of nonNull) {
    const num = parseNumber(v);
    if (num !== null) {
      numericHits++;
      numericValues.push(num);
    }
    if (isPlausibleDateHit(v)) dateHits++;
  }

  const sampleSize = nonNull.length || 1;
  const numericRatio = numericHits / sampleSize;
  const dateRatio = dateHits / sampleSize;

  let primitiveType = "string";
  // Dates take priority over numeric because Excel serial dates parse as
  // numbers too; if something looks like both, trust the date parse only
  // when it isn't ALSO cleanly numeric-looking as plain currency/quantity.
  if (dateRatio >= 0.85 && dateRatio >= numericRatio) primitiveType = "date";
  else if (numericRatio >= 0.85) primitiveType = "numeric";
  else if (uniqueRatio > 0.98 && nonNull.length > 20) primitiveType = "id";

  const profile = {
    header,
    rowCount: n,
    nulls,
    nullRatio: round(nullRatio),
    unique: uniqueSet.size,
    uniqueRatio: round(uniqueRatio),
    primitiveType,
    samples: nonNull.slice(0, 5).map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)),
  };

  if (primitiveType === "numeric") {
    numericValues.sort((a, b) => a - b);
    const sum = numericValues.reduce((a, b) => a + b, 0);
    profile.stats = {
      min: numericValues[0] ?? null,
      max: numericValues[numericValues.length - 1] ?? null,
      mean: numericValues.length ? round(sum / numericValues.length) : null,
      median: numericValues.length ? numericValues[Math.floor(numericValues.length / 2)] : null,
      allPositive: numericValues.every((v) => v >= 0),
      hasDecimals: numericValues.some((v) => !Number.isInteger(v)),
    };
  }

  if (primitiveType === "date") {
    const parsed = nonNull.map((v) => parseDate(v)).filter(Boolean).sort();
    profile.stats = {
      min: parsed[0] ?? null,
      max: parsed[parsed.length - 1] ?? null,
      format: detectDateFormat(nonNull),
    };
  }

  return profile;
}

/**
 * Profile every column of a dataset (array of row objects, as produced by
 * XLSX.utils.sheet_to_json or a SQL row set).
 */
export function profileDataset(headers, rows) {
  const columns = {};
  for (const header of headers) {
    const values = rows.map((r) => r[header]);
    columns[header] = profileColumn(header, values);
  }
  return { rowCount: rows.length, columnCount: headers.length, columns };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
