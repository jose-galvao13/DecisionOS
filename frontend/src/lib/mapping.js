// Excel/CSV header detection, row parsing and the raw→unified-model
// transform used by Onboarding + DataSources before analytics can run.

/* ---------------------------------------------------------------
   UNIFIED DATA MODEL — field detection + parsing
   Any source (Excel today; Database/API in a future backend)
   normalizes into the same transaction shape:
   { date, product, customer, region, channel, quantity, revenue, cost, profit }
----------------------------------------------------------------*/
const FIELD_KEYWORDS = {
  date: ["date", "data", "dia", "transaction date"],
  product: ["product", "produto", "item", "sku", "artigo"],
  customer: ["customer", "cliente", "client"],
  revenue: ["revenue", "receita", "sales", "venda", "vendas", "valor", "amount"],
  cost: ["cost", "custo", "custos"],
  region: ["region", "regiao", "região", "country", "pais", "país", "market"],
  channel: ["channel", "canal"],
  quantity: ["quantity", "qty", "quantidade", "qtd", "units"],
};
// Optional fields: detected when present, but never block onboarding if absent —
// a plain sales-transaction export usually won't have these.
const OPTIONAL_FIELD_KEYWORDS = {
  unitPrice: ["unit price", "preco unitario", "preço unitário", "unit_price", "price"],
  discount: ["discount", "desconto", "rebate"],
  currency: ["currency", "moeda", "ccy"],
};

function detectMapping(headers) {
  const map = {};
  for (const field of Object.keys(FIELD_KEYWORDS)) {
    const hit = headers.find((h) =>
      FIELD_KEYWORDS[field].some((kw) => h.toLowerCase().trim() === kw || h.toLowerCase().includes(kw))
    );
    map[field] = hit || null;
  }
  for (const field of Object.keys(OPTIONAL_FIELD_KEYWORDS)) {
    const hit = headers.find((h) =>
      OPTIONAL_FIELD_KEYWORDS[field].some((kw) => h.toLowerCase().trim() === kw || h.toLowerCase().includes(kw))
    );
    map[field] = hit || null;
  }
  return map;
}

function parseNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  const cleaned = String(v).replace(/[€$\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseDateVal(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") {
    // Excel serial date
    const d = XLSX.SSF ? XLSX.SSF.parse_date_code(v) : null;
    if (d) return new Date(d.y, d.m - 1, d.d);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = "20" + y;
    return new Date(Number(y), Number(b) - 1, Number(a));
  }
  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// slugify: turns a dimension label into a stable id, e.g. "Produto X" -> "produto-x".
// Real connectors would carry real dimension ids (customer_id, product_id, ...);
// with only a flat transaction export we derive them from the label instead of
// leaving the model without any id at all.
const slugify = (s) => String(s || "n-d").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "n-d";

function buildUnifiedModel(rows, mapping) {
  const out = [];
  let i = 0;
  for (const r of rows) {
    const date = mapping.date ? parseDateVal(r[mapping.date]) : null;
    const revenue = mapping.revenue ? parseNumber(r[mapping.revenue]) : null;
    if (!date || revenue == null) continue;
    const cost = mapping.cost ? parseNumber(r[mapping.cost]) ?? 0 : 0;
    const quantity = mapping.quantity ? parseNumber(r[mapping.quantity]) ?? 1 : 1;
    const product = mapping.product ? String(r[mapping.product] ?? "N/D").trim() : "N/D";
    const customer = mapping.customer ? String(r[mapping.customer] ?? "").trim() : "";
    const region = mapping.region ? String(r[mapping.region] ?? "N/D").trim() : "N/D";
    const channel = mapping.channel ? String(r[mapping.channel] ?? "").trim() : "";
    const discount = mapping.discount ? parseNumber(r[mapping.discount]) ?? 0 : 0;
    const unitPrice = mapping.unitPrice
      ? parseNumber(r[mapping.unitPrice]) ?? (revenue / (quantity || 1))
      : revenue / (quantity || 1);
    out.push({
      id: `TXN-${i++}`,
      date,
      product, customer, region, channel,
      productId: slugify(product), customerId: customer ? slugify(customer) : "",
      regionId: slugify(region), channelId: channel ? slugify(channel) : "",
      quantity, unitPrice, discount,
      revenue, cost, profit: revenue - cost,
      currency: mapping.currency ? String(r[mapping.currency] ?? "EUR").trim() : "EUR",
      source: "excel",
    });
  }
  return out.sort((a, b) => a.date - b.date);
}

function computeDataQuality(rows, mapping) {
  const total = rows.length || 1;
  const mappedFields = Object.entries(mapping).filter(([, v]) => v);
  let missingCells = 0, totalCells = 0;
  rows.forEach((r) => mappedFields.forEach(([, col]) => {
    totalCells++;
    if (r[col] == null || String(r[col]).trim() === "") missingCells++;
  }));
  const seen = new Set();
  let duplicates = 0;
  rows.forEach((r) => {
    const key = mappedFields.map(([, col]) => r[col]).join("|");
    if (seen.has(key)) duplicates++; else seen.add(key);
  });
  const invalidIds = mapping.customer ? rows.filter((r) => !r[mapping.customer] || String(r[mapping.customer]).trim() === "").length : 0;
  const catSets = {};
  ["product", "region", "channel"].forEach((f) => { if (mapping[f]) catSets[f] = new Set(); });
  let inconsistent = 0;
  Object.keys(catSets).forEach((f) => {
    const lower = new Set();
    rows.forEach((r) => {
      const val = r[mapping[f]];
      if (!val) return;
      catSets[f].add(String(val).trim());
      lower.add(String(val).trim().toLowerCase());
    });
  });
  Object.keys(catSets).forEach((f) => {
    const raw = [...catSets[f]];
    const byLower = {};
    raw.forEach((v) => { byLower[v.toLowerCase()] = (byLower[v.toLowerCase()] || 0) + 1; });
    inconsistent += Object.values(byLower).filter((c) => c > 1).length;
  });
  const healthPct = Math.max(0, 100 - (missingCells / totalCells) * 100 - (duplicates / total) * 15 - (invalidIds / total) * 10);
  return {
    healthPct: Math.round(healthPct * 10) / 10,
    missingPct: ((missingCells / totalCells) * 100).toFixed(1) + "%",
    duplicates, invalidIds, inconsistent,
    rows: rows.length,
  };
}


export { detectMapping, parseNumber, parseDateVal, slugify, buildUnifiedModel, computeDataQuality };
