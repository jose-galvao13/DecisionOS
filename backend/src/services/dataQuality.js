import { parseDate, parseNumber, normalizeKey } from "../utils/parse.js";

/** rows: array of raw row objects (header -> value). mapping: field -> header name.
 *  Returns { score, issues } where issues is the list the Data Quality
 *  Center UI renders (🔴/🟡/🟢), plus per-row validity flags the importer
 *  reuses so it doesn't re-derive them. */
export function assessQuality(rows, mapping) {
  if (!rows.length) {
    // Nothing to assess yet — not an error, just nothing to report on.
    return { score: 100, issues: [] };
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
      count: missingCustomer,
    });
  }
  if (invalidDate > 0) {
    issues.push({
      severity: invalidDate / total > 0.05 ? "red" : "yellow",
      code: "invalid_dates",
      message: `${invalidDate} datas inválidas`,
      count: invalidDate,
    });
  }
  if (missingRevenue > 0) {
    issues.push({
      severity: missingRevenue / total > 0.05 ? "red" : "yellow",
      code: "missing_revenue",
      message: `${missingRevenue} transações sem receita válida`,
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
      count: currencySet.size,
    });
  }

  const validRows = total - new Set([...Array(total).keys()].filter((i) => !rowFlags[i].dateOk || !rowFlags[i].revenueOk)).size;
  const validRevenuePct = (validRows / total) * 100;
  issues.push({
    severity: "green",
    code: "valid_revenue_pct",
    message: `${validRevenuePct.toFixed(1)}% das receitas válidas`,
    count: validRows,
  });

  // Simple composite score: 100 minus a penalty per problem class, floor 0.
  const score = Math.max(
    0,
    100 - (missingCustomer / total) * 30 - (invalidDate / total) * 40 - (missingRevenue / total) * 40
  );

  return { score: Number(score.toFixed(1)), issues, rowFlags };
}
