// RELATIONSHIP DETECTION ENTRE DATASETS (pontos 5, 10, 11 + revisão "não
// dependas só do overlapRatio")
//
//   Clientes.CustomerID  ↕  Vendas.Customer
//
// A revisão aponta um caso concreto onde overlap sozinho engana:
//   Produtos.Nome  = [Apple, Samsung, Sony]
//   Vendas.Marca   = [Apple, Samsung, Sony, LG]
// Overlap alto (100% de Produtos.Nome está em Vendas.Marca), mas isso não
// PROVA que seja a mesma chave — podia ser coincidência de valores comuns
// (marcas genéricas, países, categorias pequenas). Por isso a confiança
// agora é uma soma de sinais independentes, não só o overlap:
//
//   confidence = overlap        (peso .45)
//              + categoryMatch  (peso .20)  — ambos IDENTIFIER/ENTITY?
//              + cardinality    (peso .20)  — um lado é claramente "1", o outro "N"?
//              + nameSimilarity (peso .15)  — os nomes das colunas/valores-tipo se parecem?
//
// Cada relação reportada vem com a lista de sinais que a sustentam, no
// formato que a revisão pediu:
//   ✓ 100% overlap
//   ✓ Cliente é ENTITY
//   ✓ Clientes.Nome é ENTITY
//   ✓ Clientes tem valores únicos
//   ✓ Vendas.Cliente repete valores

function toComparableSet(values) {
  const set = new Set();
  for (const v of values) {
    if (v === null || v === undefined || v === "") continue;
    set.add(String(v).trim().toLowerCase());
  }
  return set;
}

function overlapRatio(smallSet, bigSet) {
  if (!smallSet.size) return 0;
  let hits = 0;
  for (const v of smallSet) if (bigSet.has(v)) hits++;
  return hits / smallSet.size;
}

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s_\-]+/g, "");
}

// Very cheap name-similarity: exact match, substring, or shared stem
// (e.g. "Cliente" / "ClienteID" / "Clientes"). This is a bonus signal, not
// a requirement — "Cliente" (Vendas) and "Nome" (Clientes) share no text
// at all and are still a valid relationship, corroborated by the other
// three signals instead.
function nameSimilarity(headerA, headerB) {
  const a = norm(headerA);
  const b = norm(headerB);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (shorter.length >= 3 && longer.startsWith(shorter.slice(0, Math.min(4, shorter.length)))) return 0.4;
  return 0;
}

// Only test columns that plausibly represent an entity/key, not free-text
// or measure columns, which would produce meaningless coincidental overlaps.
const KEY_CATEGORIES = new Set(["IDENTIFIER", "ENTITY", "LOCATION", "DIMENSION"]);

function candidateColumns(dataset) {
  return dataset.analysis.fields.filter(
    (f) => f.status !== "UNKNOWN" && KEY_CATEGORIES.has(f.category) && dataset.analysis.rowCount >= 3
  );
}

const WEIGHTS = { overlap: 0.45, category: 0.2, cardinality: 0.2, name: 0.15 };

/**
 * @param {Array<{name: string, headers: string[], rows: object[], analysis: object}>} datasets
 * @param {object} [opts]
 * @param {number} [opts.minConfidence] minimum composite confidence to report (default 0.6)
 */
export function detectRelationships(datasets, { minConfidence = 0.6 } = {}) {
  const relationships = [];

  for (let i = 0; i < datasets.length; i++) {
    for (let j = i + 1; j < datasets.length; j++) {
      const a = datasets[i];
      const b = datasets[j];

      for (const colA of candidateColumns(a)) {
        const setA = toComparableSet(a.rows.map((r) => r[colA.header]));
        if (setA.size < 2) continue;

        for (const colB of candidateColumns(b)) {
          const setB = toComparableSet(b.rows.map((r) => r[colB.header]));
          if (setB.size < 2) continue;

          const ratioAinB = overlapRatio(setA, setB);
          const ratioBinA = overlapRatio(setB, setA);
          const overlap = Math.max(ratioAinB, ratioBinA);
          if (overlap < 0.4) continue; // hard floor before even scoring the rest — no point building evidence for near-zero overlap

          // SINAL: categoria semântica compatível (dois IDENTIFIER, ou um
          // IDENTIFIER com um ENTITY — ex: Clientes.ID com Vendas.ClienteNome
          // não bate tão bem como Clientes.ID com Vendas.ClienteID).
          const sameCategory = colA.category === colB.category;
          const categoryScore = sameCategory ? 1 : colA.category && colB.category ? 0.4 : 0;

          // SINAL: cardinalidade assimétrica — uma relação genuína quase
          // sempre tem um lado claramente "mais único" que o outro. Se os
          // dois lados forem igualmente únicos (ou igualmente repetitivos),
          // isso é MENOS convincente como dimensão/facto, não mais — é
          // exatamente o caso Produtos.Nome vs Vendas.Marca do exemplo: se
          // ambos tiverem uniqueRatio parecido dentro do respetivo dataset,
          // a "direção" 1:N fica ambígua.
          const uniqA = colA.confidence != null ? setA.size / a.rows.length : 0;
          const uniqB = setB.size / b.rows.length;
          const uniqA2 = setA.size / a.rows.length;
          const asymmetry = Math.abs(uniqA2 - uniqB);
          const cardinalityScore = Math.min(asymmetry * 2, 1); // 0 = idêntica unicidade (suspeito), 1 = bem diferente (um claramente dimensão)

          const nameScore = nameSimilarity(colA.header, colB.header);

          const confidence =
            overlap * WEIGHTS.overlap + categoryScore * WEIGHTS.category + cardinalityScore * WEIGHTS.cardinality + nameScore * WEIGHTS.name;
          if (confidence < minConfidence) continue;

          const aIsDimension = uniqA2 >= uniqB; // maior proporção de valores distintos -> mais "dimensão"
          const dim = aIsDimension ? { dataset: a.name, column: colA.header, set: setA, rows: a.rows.length } : { dataset: b.name, column: colB.header, set: setB, rows: b.rows.length };
          const fact = aIsDimension ? { dataset: b.name, column: colB.header, set: setB, rows: b.rows.length } : { dataset: a.name, column: colA.header, set: setA, rows: a.rows.length };

          const evidence = [`${Math.round(overlap * 100)}% overlap entre "${colA.header}" (${a.name}) e "${colB.header}" (${b.name})`];
          if (sameCategory) evidence.push(`Ambas as colunas são ${colA.category}`);
          else evidence.push(`"${colA.header}" é ${colA.category}, "${colB.header}" é ${colB.category}`);
          evidence.push(`"${dim.column}" (${dim.dataset}) tem ${dim.set.size}/${dim.rows} valores distintos → lado dimensão ("1")`);
          evidence.push(`"${fact.column}" (${fact.dataset}) repete valores com mais frequência → lado facto ("N")`);
          if (nameScore >= 0.4) evidence.push(`Nomes das colunas são semelhantes ("${colA.header}" / "${colB.header}")`);
          if (cardinalityScore < 0.3) {
            evidence.push(`Aviso: as duas colunas têm unicidade parecida — a direção dimensão/facto é menos certa que o normal`);
          }

          relationships.push({
            from: { dataset: fact.dataset, column: fact.column },
            to: { dataset: dim.dataset, column: dim.column },
            cardinality: "1:N",
            confidence: round(confidence),
            overlapRatio: round(overlap),
            evidence,
          });
        }
      }
    }
  }

  relationships.sort((r1, r2) => r2.confidence - r1.confidence);
  return relationships;
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
