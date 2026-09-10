// PIPELINE COMPLETO DO WORKBOOK (ordem corrigida pela revisão arquitetural):
//
//   1. STRUCTURE DISCOVERY   (structureDiscovery.js) — onde está a tabela?
//   2. DATA PROFILING        (profiling.js)           — que tipo tem cada coluna?
//   3. SEMANTIC UNDERSTANDING(semanticTypes.js)        — o que significa?
//   4. CANDIDATE COMPETITION + 5. CONFIDENCE           (confidence.js)
//   6. RELATIONSHIP ENGINE   (relationships.js)        — entre tabelas
//   7. HUMAN CONFIRMATION    — feito no frontend, a partir daqui
//
// Antes, este ficheiro assumia "linha 1 = cabeçalho" por folha. Agora cada
// folha passa primeiro pelo Structure Discovery, que pode encontrar 0
// (folha vazia/config), 1, ou várias tabelas (multi-tabela numa folha).
// Só DEPOIS de isolar a região de dados real é que profiling/semântica
// entram em jogo — estrutura e significado nunca se misturam.
import { discoverTables, materializeTable } from "./structureDiscovery.js";
import { analyzeDataset } from "./index.js";
import { detectRelationships } from "./relationships.js";

const SUMMARY_NAME_HINTS = ["resumo", "summary", "totais", "totals", "dashboard", "overview", "kpi", "config", "configuração"];

/**
 * Heuristic-flag a table as likely-a-real-dataset vs likely-a-summary/pivot
 * that a human should confirm before the engine treats it as tabular data.
 */
function looksAmbiguous(sheetName, tableIndex, rows, headers, analysis) {
  const reasons = [];
  const nameNorm = sheetName.trim().toLowerCase();
  if (tableIndex === 0 && SUMMARY_NAME_HINTS.some((hint) => nameNorm.includes(hint))) {
    reasons.push(`Nome da folha ("${sheetName}") sugere um resumo/dashboard/configuração, não uma tabela de dados`);
  }
  if (rows.length < 3) reasons.push("Muito poucas linhas para confirmar que é uma tabela de dados");
  if (headers.length < 2) reasons.push("Só tem uma coluna");
  const unknownRatio = analysis.summary.unknown / Math.max(headers.length, 1);
  if (unknownRatio > 0.5) reasons.push("Mais de metade das colunas não foram reconhecidas");
  return { ambiguous: reasons.length > 0, reasons };
}

/**
 * @param {Record<string, Array<Array<any>>>} sheetsAoa sheet name -> raw
 *        array-of-arrays cell data (e.g. XLSX.utils.sheet_to_json(sheet,
 *        { header: 1, defval: null })) — deliberately NOT pre-parsed into
 *        header/row objects, because that decision (where the header even
 *        is) is exactly what Structure Discovery has to make first.
 */
export function analyzeWorkbook(sheetsAoa) {
  const sheetNames = Object.keys(sheetsAoa);
  const tables = []; // flattened list across all sheets: {sheetName, tableIndex, name, ...}
  const sheetSummaries = [];

  for (const sheetName of sheetNames) {
    const aoa = sheetsAoa[sheetName];
    if (!aoa || !aoa.length) {
      sheetSummaries.push({ name: sheetName, tablesFound: 0, unparsedRowCount: 0, structureNote: "Folha vazia" });
      continue;
    }

    const { tables: discovered, unparsedRowCount } = discoverTables(aoa);

    if (!discovered.length) {
      sheetSummaries.push({
        name: sheetName,
        tablesFound: 0,
        unparsedRowCount,
        structureNote: "Não foi encontrada nenhuma tabela reconhecível nesta folha (pode ser texto livre, configuração, ou um layout demasiado irregular)",
      });
      continue;
    }

    discovered.forEach((table, tableIndex) => {
      const { headers, rows } = materializeTable(aoa, table);
      const displayName = discovered.length > 1 ? `${sheetName} (Tabela ${tableIndex + 1})` : sheetName;

      if (!rows.length) {
        tables.push({
          sheetName, tableIndex, name: displayName, headers, rows: [], analysis: null,
          ambiguous: true, ambiguousReasons: ["Cabeçalho encontrado mas sem linhas de dados"],
          structure: { titleRowCount: table.titleRows.length, totalsRowCount: table.totalsRowIdxs.length },
        });
        return;
      }

      const analysis = analyzeDataset(headers, rows);
      const { ambiguous, reasons } = looksAmbiguous(sheetName, tableIndex, rows, headers, analysis);
      tables.push({
        sheetName, tableIndex, name: displayName, headers, rows, analysis,
        ambiguous, ambiguousReasons: reasons,
        structure: {
          titleRowCount: table.titleRows.length, // linhas de título ignoradas antes do cabeçalho
          totalsRowCount: table.totalsRowIdxs.length, // linhas de totais excluídas dos dados
        },
      });
    });

    sheetSummaries.push({
      name: sheetName,
      tablesFound: discovered.length,
      unparsedRowCount, // conteúdo residual que não formou nenhuma tabela reconhecível (notas, rodapés, etc.)
    });
  }

  // Relationships correm sobre as tabelas CONFIRMADAS de TODAS as folhas —
  // uma relação Vendas↔Clientes é válida mesmo que estejam em folhas
  // diferentes, e uma tabela ambígua ("Resumo") nunca entra nesta análise.
  const confirmedTables = tables.filter((t) => t.analysis && !t.ambiguous);
  const relationships = confirmedTables.length >= 2 ? detectRelationships(confirmedTables) : [];

  return {
    sheets: sheetSummaries, // structural summary per sheet (how many tables were found in it)
    tables: tables.map((t) => ({
      sheetName: t.sheetName,
      tableIndex: t.tableIndex,
      name: t.name,
      rowCount: t.rows.length,
      columnCount: t.headers.length,
      ambiguous: t.ambiguous,
      ambiguousReasons: t.ambiguousReasons,
      structure: t.structure,
      analysis: t.analysis, // null when there were no data rows at all
      headers: t.headers,
      rows: t.rows, // full materialized rows (structure-cleaned: no titles, no totals) for staging/commit downstream
    })),
    relationships,
    summary: {
      totalSheets: sheetNames.length,
      totalTables: tables.length,
      confirmed: confirmedTables.length,
      ambiguous: tables.filter((t) => t.ambiguous).length,
    },
  };
}
