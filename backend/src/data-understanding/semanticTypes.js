// FASE 3 — SEMANTIC TYPE DETECTION (pontos 2, 3, 8, 9, 14 do documento)
//
// A ideia central (ponto 9): "Não uses apenas o nome da coluna." Uma
// coluna chamada "Amount" pode ser REVENUE, COST, PROFIT ou QUANTITY — o
// nome sozinho não chega. Por isso cada tipo semântico é avaliado com
// vários sinais independentes e o resultado é a soma ponderada:
//
//   semanticScore = headerScore + typeScore + distributionScore + relationshipScore
//
// PONTO 2 — genericidade: o vocabulário está organizado em duas camadas.
// Tipos ESPECÍFICOS de domínio (REVENUE, CUSTOMER, PRODUCT_ID, ...) têm
// sinónimos e competem primeiro. Tipos GENÉRICOS (MEASURE, ENTITY,
// CATEGORY, IDENTIFIER) não têm sinónimos — vencem apenas por tipo de
// dados + distribuição — e servem de rede de segurança para domínios que o
// vocabulário específico não cobre (funcionários, inventário, etc.). Uma
// coluna nunca fica sem classificação só porque "Salary" ou "Department"
// não estão na lista de vendas: cai para MEASURE/CATEGORY genérico em vez
// de UNKNOWN.
//
// PONTO 3 — competição: o score absoluto de um candidato não chega para
// decidir AUTO. "Total" pode pontuar bem para REVENUE mesmo sem evidência
// suficiente, e "Custo" pode parecer REVENUE só por também ser numérico
// positivo. Por isso a MARGEM entre o 1º e o 2º candidato é decidida em
// confidence.js, não aqui — este ficheiro devolve sempre a lista ordenada
// completa (não só o vencedor) para essa comparação ser possível.

const WEIGHTS = { header: 0.4, type: 0.2, distribution: 0.25, relationship: 0.15 };

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ---------------------------------------------------------------------
// DOMAIN-SPECIFIC vocabulary (sales/commerce today; extend per-vertical by
// adding more entries here — each one is independent, nothing else needs
// to change).
// ---------------------------------------------------------------------
const DOMAIN_VOCAB = {
  DATE: {
    category: "DATE",
    synonyms: ["date", "data", "order date", "data da encomenda", "transaction date", "data venda", "dt", "hire date", "data contratacao"],
    expectedPrimitive: "date",
    distribution: (p) => (p.primitiveType === "date" ? 1 : 0),
  },
  CUSTOMER: {
    category: "ENTITY",
    synonyms: ["customer", "cliente", "client", "customer name", "client name", "nome cliente", "cl"],
    expectedPrimitive: "string",
    distribution: (p) => {
      if (p.primitiveType !== "string") return 0;
      // Repeats across a fact table (moderate cardinality) is the classic
      // signal, but a small DIMENSION table (Clientes: one row per
      // customer) legitimately has near-100% unique names too — don't
      // penalize that case as hard as a true free-text column would be.
      if (p.uniqueRatio > 0.02 && p.uniqueRatio < 0.9) return 0.7;
      if (p.uniqueRatio >= 0.9) return 0.55;
      return 0.3;
    },
  },
  PRODUCT: {
    category: "ENTITY",
    synonyms: ["product", "produto", "item", "sku", "article", "artigo", "product name", "ref"],
    expectedPrimitive: "string",
    distribution: (p) => {
      if (p.primitiveType !== "string") return 0;
      if (p.uniqueRatio > 0.005 && p.uniqueRatio < 0.8) return 0.6;
      return 0.25;
    },
  },
  REGION: {
    category: "LOCATION",
    synonyms: ["region", "regiao", "região", "country", "pais", "país", "market", "mercado", "zona", "zone", "location", "localizacao", "localização"],
    expectedPrimitive: "string",
    distribution: (p) => (p.primitiveType === "string" && p.uniqueRatio < 0.3 ? 0.7 : 0.2),
  },
  CHANNEL: {
    category: "DIMENSION",
    synonyms: ["channel", "canal", "sales channel"],
    expectedPrimitive: "string",
    distribution: (p) => (p.primitiveType === "string" && p.uniqueRatio < 0.15 ? 0.7 : 0.2),
  },
  QUANTITY: {
    category: "MEASURE",
    synonyms: ["quantity", "quantidade", "qty", "units", "unidades", "un", "stock", "estoque"],
    expectedPrimitive: "numeric",
    distribution: (p) => {
      if (p.primitiveType !== "numeric") return 0;
      let score = 0;
      if (p.stats?.allPositive) score += 0.4;
      if (!p.stats?.hasDecimals) score += 0.4;
      return Math.min(score + 0.2, 1);
    },
  },
  UNIT_PRICE: {
    category: "MEASURE",
    synonyms: ["unit price", "preco unitario", "preço unitário", "price", "preco", "preço", "unitprice"],
    expectedPrimitive: "numeric",
    distribution: (p) => (p.primitiveType === "numeric" && p.stats?.allPositive ? 0.6 : 0.1),
  },
  REVENUE: {
    category: "MEASURE",
    synonyms: ["revenue", "receita", "sales", "vendas", "amount", "total", "valor", "gross revenue", "importancia"],
    expectedPrimitive: "numeric",
    distribution: (p) => (p.primitiveType === "numeric" && p.stats?.allPositive && p.stats?.hasDecimals ? 0.6 : 0.3),
  },
  COST: {
    category: "MEASURE",
    synonyms: ["cost", "custo", "cogs", "custo unitario", "custo unitário"],
    expectedPrimitive: "numeric",
    distribution: (p) => (p.primitiveType === "numeric" && p.stats?.allPositive ? 0.6 : 0.2),
  },
  DISCOUNT: {
    category: "MEASURE",
    synonyms: ["discount", "desconto"],
    expectedPrimitive: "numeric",
    distribution: (p) => (p.primitiveType === "numeric" ? 0.5 : 0.1),
  },
  SALARY: {
    category: "MEASURE",
    synonyms: ["salary", "salario", "salário", "wage", "compensation", "remuneracao", "remuneração"],
    expectedPrimitive: "numeric",
    distribution: (p) => (p.primitiveType === "numeric" && p.stats?.allPositive ? 0.6 : 0.2),
  },
  STATUS: {
    category: "STATUS",
    synonyms: ["status", "estado", "situacao", "situação"],
    expectedPrimitive: "string",
    distribution: (p) => (p.primitiveType === "string" && p.uniqueRatio < 0.1 ? 0.8 : 0.2),
  },
  ORDER_ID: {
    category: "IDENTIFIER",
    synonyms: ["order id", "order number", "numero venda", "número venda", "nº venda", "invoice", "fatura"],
    expectedPrimitive: "id",
    distribution: (p) => (looksIdentifierShaped(p) ? 0.8 : 0.1),
  },
  CUSTOMER_ID: {
    category: "IDENTIFIER",
    synonyms: ["customer id", "id cliente", "clientid", "client id"],
    expectedPrimitive: "id",
    distribution: (p) => (looksIdentifierShaped(p) && p.uniqueRatio > 0.3 ? 0.6 : 0.1),
  },
  PRODUCT_ID: {
    category: "IDENTIFIER",
    synonyms: ["product id", "id produto", "sku", "productid"],
    expectedPrimitive: "id",
    distribution: (p) => (looksIdentifierShaped(p) && p.uniqueRatio > 0.005 ? 0.5 : 0.1),
  },
};

// ---------------------------------------------------------------------
// GENERIC vocabulary (ponto 2): no synonyms — these can never win the
// headerScore signal, so their weight is redistributed to type+
// distribution only (same trick used for the relationship signal below).
// They exist purely so an out-of-domain column (Department, Manager,
// Warehouse, Supplier...) lands on a meaningful, honest category instead
// of UNKNOWN.
// ---------------------------------------------------------------------
const GENERIC_VOCAB = {
  GENERIC_DATE: {
    category: "DATE",
    generic: true,
    expectedPrimitive: "date",
    distribution: (p) => (p.primitiveType === "date" ? 0.9 : 0),
  },
  GENERIC_IDENTIFIER: {
    category: "IDENTIFIER",
    generic: true,
    expectedPrimitive: "id",
    distribution: (p) => (looksIdentifierShaped(p) ? 0.9 : p.uniqueRatio > 0.5 ? 0.2 : 0.1),
  },
  GENERIC_MEASURE: {
    category: "MEASURE",
    generic: true,
    expectedPrimitive: "numeric",
    distribution: (p) => (p.primitiveType === "numeric" ? (p.stats?.allPositive ? 0.7 : 0.5) : 0),
  },
  GENERIC_ENTITY: {
    category: "ENTITY",
    generic: true,
    expectedPrimitive: "string",
    distribution: (p) => (p.primitiveType === "string" && p.uniqueRatio > 0.02 && p.uniqueRatio < 0.95 ? 0.6 : 0.15),
  },
  GENERIC_CATEGORY: {
    category: "CATEGORY",
    generic: true,
    expectedPrimitive: "string",
    distribution: (p) => (p.primitiveType === "string" && p.uniqueRatio < 0.2 ? 0.6 : 0.15),
  },
};

export const SEMANTIC_VOCAB = { ...DOMAIN_VOCAB, ...GENERIC_VOCAB };
export { DOMAIN_VOCAB, GENERIC_VOCAB };

function headerScore(header, syns) {
  if (!syns || !syns.length) return 0; // generic types have no synonyms by design
  const h = norm(header);
  const normSyns = syns.map(norm);
  if (normSyns.includes(h)) return 1;
  if (normSyns.some((s) => h.includes(s) || s.includes(h))) return 0.7;
  const hTokens = new Set(h.split(/[\s_\-]+/).filter(Boolean));
  let bestOverlap = 0;
  for (const s of normSyns) {
    const sTokens = s.split(/[\s_\-]+/).filter(Boolean);
    const overlap = sTokens.filter((t) => hTokens.has(t)).length;
    if (sTokens.length) bestOverlap = Math.max(bestOverlap, overlap / sTokens.length);
  }
  return bestOverlap * 0.5;
}

// A real identifier is a discrete, mostly-unique key — not a continuous
// decimal measure that merely happens to have distinct values because
// it's money/quantities (e.g. 50 different invoice amounts are all
// "unique" but that doesn't make the column an ID). Any "id"-shaped
// scoring must exclude that case explicitly, or a plain numeric measure
// column can outscore genuine identifier candidates.
function looksIdentifierShaped(profile) {
  if (profile.primitiveType === "numeric" && profile.stats?.hasDecimals) return false;
  return profile.uniqueRatio > 0.9;
}

function typeScore(profile, expectedPrimitive) {
  if (expectedPrimitive === "id") {
    if (!looksIdentifierShaped(profile)) return profile.uniqueRatio > 0.5 && !profile.stats?.hasDecimals ? 0.3 : 0;
    return 1;
  }
  return profile.primitiveType === expectedPrimitive ? 1 : 0;
}

// RELATIONSHIP SIGNAL (ponto 9): "Amount ≈ Qty × Price" é uma evidência
// muito mais forte do que o nome da coluna sozinho.
function relationshipScore(semanticType, header, headers, rows, profiles) {
  if (semanticType !== "REVENUE" && semanticType !== "COST") return 0;

  const qtyHeader = headers.find((h) => h !== header && guessLooksLike(profiles[h], ["QUANTITY"]));
  const priceHeader = headers.find((h) => h !== header && guessLooksLike(profiles[h], ["UNIT_PRICE"]));
  if (!qtyHeader || !priceHeader) return 0;

  let matches = 0;
  let checked = 0;
  const sampleRows = rows.slice(0, 100);
  for (const row of sampleRows) {
    const amount = Number(row[header]);
    const qty = Number(row[qtyHeader]);
    const price = Number(row[priceHeader]);
    if (!isFinite(amount) || !isFinite(qty) || !isFinite(price)) continue;
    checked++;
    const expected = qty * price;
    const tolerance = Math.max(Math.abs(expected) * 0.05, 0.02);
    if (Math.abs(expected - amount) <= tolerance) matches++;
  }
  if (checked < 3) return 0;
  return matches / checked;
}

function guessLooksLike(profile, candidateTypes) {
  if (!profile) return false;
  for (const type of candidateTypes) {
    const vocab = SEMANTIC_VOCAB[type];
    if (headerScore(profile.header, vocab.synonyms) >= 0.5 && vocab.expectedPrimitive === profile.primitiveType) {
      return true;
    }
  }
  return false;
}

// Types whose weight includes a signal that doesn't apply to them (no
// synonyms, or relationship not meaningful) get that weight redistributed
// among the remaining signals, so every type can still reach a 1.0
// ceiling — otherwise generic types (no header signal) or non-revenue
// types (no relationship signal) would be structurally capped below the
// AUTO threshold no matter how good the evidence is.
const RELATIONSHIP_APPLIES_TO = new Set(["REVENUE", "COST"]);

function effectiveWeights({ hasHeaderSignal, hasRelationshipSignal }) {
  if (hasHeaderSignal && hasRelationshipSignal) return WEIGHTS;
  let usable = 0;
  if (hasHeaderSignal) usable += WEIGHTS.header;
  usable += WEIGHTS.type + WEIGHTS.distribution;
  if (hasRelationshipSignal) usable += WEIGHTS.relationship;
  const scale = 1 / usable;
  return {
    header: hasHeaderSignal ? WEIGHTS.header * scale : 0,
    type: WEIGHTS.type * scale,
    distribution: WEIGHTS.distribution * scale,
    relationship: hasRelationshipSignal ? WEIGHTS.relationship * scale : 0,
  };
}

/**
 * Score a column against a given vocabulary subset. Internal — callers use
 * scoreDomainTypes()/scoreGenericTypes() below so the orchestrator
 * (index.js) can treat generic types strictly as a fallback rather than a
 * full competitor (see index.js for why: a generic type winning over a
 * clear domain match was an earlier bug in this engine).
 */
function scoreAgainstVocab(header, profile, { headers, rows, profiles }, vocab) {
  const results = [];
  for (const [type, def] of Object.entries(vocab)) {
    const hasHeaderSignal = !def.generic;
    const relApplies = RELATIONSHIP_APPLIES_TO.has(type);

    const hScore = hasHeaderSignal ? headerScore(header, def.synonyms) : 0;
    const tScore = typeScore(profile, def.expectedPrimitive);
    const dScore = def.distribution(profile);
    const rScore = relApplies ? relationshipScore(type, header, headers, rows, profiles) : 0;

    const w = effectiveWeights({ hasHeaderSignal, hasRelationshipSignal: relApplies });
    const total = hScore * w.header + tScore * w.type + dScore * w.distribution + rScore * w.relationship;

    const reasons = [];
    if (hScore >= 0.7) reasons.push(`Nome da coluna corresponde ao vocabulário de "${type}"`);
    else if (hScore > 0) reasons.push(`Nome da coluna é parcialmente semelhante a "${type}"`);
    if (tScore === 1) reasons.push(`Tipo de dados (${profile.primitiveType}) é o esperado para ${type}`);
    if (dScore >= 0.6) reasons.push(`Distribuição dos valores é típica de ${type}`);
    if (rScore >= 0.6) reasons.push(`Qty × Preço Unitário ≈ valor desta coluna em ${Math.round(rScore * 100)}% das linhas amostradas`);
    if (def.generic && !reasons.length) reasons.push(`Sem vocabulário específico, mas o tipo de dados e a distribuição sugerem ${def.category.toLowerCase()}`);

    results.push({ semanticType: type, category: def.category, generic: !!def.generic, score: round(total), reasons });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

/** Ranked list against the sales/commerce-specific vocabulary only. */
export function scoreDomainTypes(header, profile, ctx) {
  return scoreAgainstVocab(header, profile, ctx, DOMAIN_VOCAB);
}

/** Ranked list against the generic (no-synonym) fallback vocabulary only. */
export function scoreGenericTypes(header, profile, ctx) {
  return scoreAgainstVocab(header, profile, ctx, GENERIC_VOCAB);
}

/** Backward-compatible: both vocabularies together (used by relationships.js
 *  helpers and tests that don't care about the domain/generic split). */
export function scoreColumn(header, profile, ctx) {
  return scoreAgainstVocab(header, profile, ctx, SEMANTIC_VOCAB);
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
