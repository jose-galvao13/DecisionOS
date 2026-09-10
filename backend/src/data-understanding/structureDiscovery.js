// STRUCTURE DISCOVERY ENGINE (pontos "Fase A/B/C" da revisão arquitetural)
//
// Estrutura e semântica são problemas diferentes — este ficheiro só
// responde a UMA pergunta: "onde começa e acaba a tabela dentro desta
// folha?". Não sabe nada sobre REVENUE/CUSTOMER/etc — isso é o trabalho de
// semanticTypes.js, que só corre DEPOIS deste módulo ter isolado a região
// de dados real.
//
// Um Excel real raramente é só "linha 1 = cabeçalho":
//
//   Empresa XPTO
//   Relatório de vendas 2025
//
//   Cliente | Produto | Valor
//   João    | PC      | 1200
//   Maria   | Monitor | 300
//
//   Total   |         | 1500
//
// Isto tem: 2 linhas de título, 1 linha em branco, 1 cabeçalho, 2 linhas
// de dados, 1 linha em branco, 1 linha de totais. Assumir "linha 1 =
// cabeçalho" aqui produzia um dataset com cabeçalhos ["Empresa XPTO"] e
// tudo a seguir interpretado como "dados" — incluindo a linha de totais,
// que envenenaria qualquer profiling/soma feita a jusante.
//
// ALGORITMO (heurístico, não é um parser de Excel completo):
//  1. Ignora linhas totalmente vazias.
//  2. Calcula a "largura típica" da folha = o nº de células não-vazias
//     mais comum entre as linhas com 2+ células (linhas de título/totais
//     têm tipicamente 1-2 células, muito abaixo da largura real da
//     tabela, por isso não distorcem a moda).
//  3. O cabeçalho é a PRIMEIRA linha não-vazia cuja largura bate com a
//     largura típica E cujas células são maioritariamente texto único
//     (um cabeçalho não repete nomes de coluna).
//  4. Linhas não-vazias ANTES do cabeçalho = títulos.
//  5. Linhas a seguir ao cabeçalho com a largura típica = dados.
//  6. Uma linha cujo 1º valor é "total"/"subtotal"/"soma"/... interrompe
//     os dados e fica marcada à parte (nunca entra no profiling).
//  7. Se, depois de uma linha em branco, aparecer mais conteúdo, tenta-se
//     encontrar OUTRA tabela nesse resto (recursivo, até 5 tabelas por
//     folha) — é assim que "múltiplas tabelas por folha" fica coberto.

const TOTALS_RE = /^(total|subtotal|totais|sub-?total|soma|sum|grand total)\b/i;
const MAX_TABLES_PER_SHEET = 5;

function nonEmptyCells(row) {
  return (row || []).filter((c) => c !== null && c !== undefined && String(c).trim() !== "");
}

function isBlankRow(row) {
  return nonEmptyCells(row).length === 0;
}

function isMostlyText(row) {
  const cells = nonEmptyCells(row);
  if (!cells.length) return false;
  const textCells = cells.filter((c) => typeof c !== "number" && !(c instanceof Date) && isNaN(Number(c)));
  return textCells.length / cells.length >= 0.8;
}

function hasUniqueValues(row) {
  const cells = nonEmptyCells(row).map((c) => String(c).trim().toLowerCase());
  return new Set(cells).size === cells.length;
}

function isTotalsRow(row) {
  const cells = nonEmptyCells(row);
  if (!cells.length) return false;
  return TOTALS_RE.test(String(cells[0]).trim());
}

/** Most common non-empty-cell-count among rows with >=2 cells (title/totals
 *  rows are usually much narrower and shouldn't skew this). */
function typicalWidth(rows) {
  const counts = {};
  for (const row of rows) {
    const n = nonEmptyCells(row).length;
    if (n >= 2) counts[n] = (counts[n] || 0) + 1;
  }
  let best = 0;
  let bestCount = 0;
  for (const [width, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestCount = count;
      best = Number(width);
    }
  }
  return best;
}

/**
 * Find one table starting at or after `startIdx` in `aoa` (array-of-arrays,
 * raw cell values — e.g. from XLSX.utils.sheet_to_json(sheet, {header:1})).
 * Returns null if nothing table-shaped is found in the remainder.
 */
function findOneTable(aoa, startIdx) {
  const n = aoa.length;
  let i = startIdx;
  while (i < n && isBlankRow(aoa[i])) i++;
  if (i >= n) return null;

  const remaining = aoa.slice(i);
  const width = typicalWidth(remaining);
  if (width < 2) return null; // nothing wide enough to be a real table

  const titleRows = [];
  let headerIdx = -1;
  for (let r = i; r < n; r++) {
    if (isBlankRow(aoa[r])) continue; // shouldn't normally hit given the skip above, but be safe on internal blanks
    const cells = nonEmptyCells(aoa[r]);
    if (cells.length === width && isMostlyText(aoa[r]) && hasUniqueValues(aoa[r])) {
      headerIdx = r;
      break;
    }
    titleRows.push(r);
    if (titleRows.length > 20) return null; // clearly not a title preamble — bail
  }
  if (headerIdx === -1) return null;

  const headers = aoa[headerIdx].map((c, idx) => (c !== null && c !== undefined && String(c).trim() !== "" ? String(c).trim() : `Column ${idx + 1}`));

  const dataRowIdxs = [];
  const totalsRowIdxs = [];
  let endIdx = headerIdx + 1;
  for (let r = headerIdx + 1; r < n; r++) {
    if (isBlankRow(aoa[r])) {
      endIdx = r;
      break;
    }
    // A totals row must ALSO be structurally shorter than a normal data
    // row (e.g. "Total | | 1500" has empty cells where the other columns
    // would be) — otherwise a legitimate data value that merely starts
    // with "Total ..." (e.g. a KPI row "Total Vendas | 12345" in a Resumo
    // sheet) gets wrongly excluded just because of its text.
    if (isTotalsRow(aoa[r]) && nonEmptyCells(aoa[r]).length < width) {
      totalsRowIdxs.push(r);
      endIdx = r + 1;
      continue;
    }
    dataRowIdxs.push(r);
    endIdx = r + 1;
  }

  return { titleRows, headerRowIndex: headerIdx, headers, dataRowIdxs, totalsRowIdxs, endIdx };
}

/**
 * @param {Array<Array<any>>} aoa raw sheet cells, row-major (header:1 shape)
 * @returns {{ tables: Array, unparsedRowCount: number }}
 */
export function discoverTables(aoa) {
  const tables = [];
  let cursor = 0;
  while (cursor < aoa.length && tables.length < MAX_TABLES_PER_SHEET) {
    const table = findOneTable(aoa, cursor);
    if (!table) break;
    tables.push(table);
    cursor = table.endIdx;
  }

  let unparsedRowCount = 0;
  for (let r = cursor; r < aoa.length; r++) if (!isBlankRow(aoa[r])) unparsedRowCount++;

  return { tables, unparsedRowCount };
}

/**
 * Converts one discovered table into the {headers, rows} shape the rest of
 * the Data Understanding Engine (profiling/semanticTypes/index.js) already
 * expects — i.e. this is the seam between "structure" and "everything
 * else". Row objects only ever contain the confirmed data rows: no title
 * text, no totals row, ever.
 */
export function materializeTable(aoa, table) {
  const rows = table.dataRowIdxs.map((r) => {
    const raw = aoa[r];
    const obj = {};
    table.headers.forEach((h, idx) => {
      obj[h] = raw[idx] !== undefined && raw[idx] !== "" ? raw[idx] : null;
    });
    return obj;
  });
  return { headers: table.headers, rows };
}
