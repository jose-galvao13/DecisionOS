import { parseDate, parseNumber, normalizeKey } from "../utils/parse.js";

/** rows: array of raw row objects (header -> value). mapping: field -> header name.
 *  Returns { score, issues } where issues is the list the Data Quality
 *  Center UI renders (🔴/🟡/🟢), plus per-row validity flags the importer
 *  reuses so it doesn't re-derive them. */
export function assessQuality(rows, mapping) {
  if (!rows.length) {
    // Nothing to assess yet — not an error, just nothing to report on.
    return { score: 100, issues: [], stats: { rows: 0, missingPct: 0, duplicates: 0, invalidIds: 0, inconsistent: 0 } };
  }
  const total = rows.length;
  let missingCustomer = 0;
  let invalidDate = 0;
  let missingRevenue = 0;
  const categorySet = new Set();
  const currencySet = new Set();

  const rowFlags = rows.map((row) => {
    const dateOk = !!parseDate(row[mapping.date]);
    const revenueRaw = mapping.revenue ? row[mapping.revenue] : null;
    const revenueOk = parseNumber(revenueRaw) != null;
    const customerKey = mapping.customer ? normalizeKey(row[mapping.customer]) : null;

    if (!dateOk) invalidDate++;
    if (!revenueOk) missingRevenue++;
    if (mapping.customer && !customerKey) missingCustomer++;
    if (mapping.region) categorySet.add(normalizeKey(row[mapping.region]) || "");
    if (mapping.currency) {
      const cur = String(row[mapping.currency] ?? "").trim().toUpperCase();
      if (cur) currencySet.add(cur);
    }

    return { dateOk, revenueOk };
  });

  const issues = [];
  if (missingCustomer > 0) {
    issues.push({
      severity: missingCustomer / total > 0.15 ? "red" : "yellow",
      code: "missing_customer_id",
      message: `${missingCustomer} transações sem Customer ID`,
      params: { n: missingCustomer },
      count: missingCustomer,
    });
  }
  if (invalidDate > 0) {
    issues.push({
      severity: invalidDate / total > 0.05 ? "red" : "yellow",
      code: "invalid_dates",
      message: `${invalidDate} datas inválidas`,
      params: { n: invalidDate },
      count: invalidDate,
    });
  }
  if (missingRevenue > 0) {
    issues.push({
      severity: missingRevenue / total > 0.05 ? "red" : "yellow",
      code: "missing_revenue",
      message: `${missingRevenue} transações sem receita válida`,
      params: { n: missingRevenue },
      count: missingRevenue,
    });
  }
  if (currencySet.size > 1) {
    // This is the actual risk multi-currency data poses: revenue/profit
    // totals sum raw numeric amounts regardless of currency (see
    // analyticsEngine.js), so a dataset that genuinely mixes currencies
    // produces a silently-wrong total, not just a mislabeled one. Red,
    // not yellow — because "amounts", not just "a display, this affects
    // every downstream metric until the data is split by currency or
    // converted to one before import.
    issues.push({
      severity: "red",
      code: "mixed_currencies",
      message: `Dataset mistura ${currencySet.size} moedas (${[...currencySet].join(", ")}) — configure as taxas de câmbio em Definições, ou os totais somam valores sem converter`,
      params: { n: currencySet.size, list: [...currencySet].join(", ") },
      count: currencySet.size,
    });
  }

  const validRows = total - new Set([...Array(total).keys()].filter((i) => !rowFlags[i].dateOk || !rowFlags[i].revenueOk)).size;
  const validRevenuePct = (validRows / total) * 100;
  issues.push({
    severity: "green",
    code: "valid_revenue_pct",
    message: `${validRevenuePct.toFixed(1)}% das receitas válidas`,
    params: { pct: Number(validRevenuePct.toFixed(1)) },
    count: validRows,
  });

  // Simple composite score: 100 minus a penalty per problem class, floor 0.
  const score = Math.max(
    0,
    100 - (missingCustomer / total) * 30 - (invalidDate / total) * 40 - (missingRevenue / total) * 40
  );

  return {
    score: Number(score.toFixed(1)),
    issues,
    rowFlags,
    stats: computeStats(rows, mapping, { total, missingCustomer }),
  };
}

/** The four numbers the "Data quality" cards show. They used to exist only
 *  when quality was computed in the browser (frontend lib/mapping.js); a
 *  report read back from the database only had { score, issues }, so after
 *  any page reload the cards showed "—" and the rows count was missing. */
function computeStats(rows, mapping, { total, missingCustomer }) {
  const mappedCols = Object.values(mapping || {}).filter(Boolean);

  let missingCells = 0;
  let totalCells = 0;
  const seen = new Set();
  let duplicates = 0;
  for (const row of rows) {
    for (const col of mappedCols) {
      totalCells++;
      const v = row[col];
      if (v == null || String(v).trim() === "") missingCells++;
    }
    const key = JSON.stringify(mappedCols.map((col) => row[col] ?? null));
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }

  // Same value written two ways ("Norte" / "norte ") in a category column.
  let inconsistent = 0;
  for (const field of ["product", "region", "channel"]) {
    const col = mapping?.[field];
    if (!col) continue;
    const variantsByLower = new Map(); // lowercased -> Set of distinct trimmed spellings
    for (const row of rows) {
      const raw = row[col];
      if (raw == null || raw === "") continue;
      const trimmed = String(raw).trim();
      if (!trimmed) continue;
      const lower = trimmed.toLowerCase();
      if (!variantsByLower.has(lower)) variantsByLower.set(lower, new Set());
      variantsByLower.get(lower).add(trimmed);
    }
    for (const variants of variantsByLower.values()) if (variants.size > 1) inconsistent++;
  }

  return {
    rows: total,
    missingPct: totalCells ? Number(((missingCells / totalCells) * 100).toFixed(1)) : 0,
    duplicates,
    invalidIds: mapping?.customer ? missingCustomer : 0,
    inconsistent,
  };
}
