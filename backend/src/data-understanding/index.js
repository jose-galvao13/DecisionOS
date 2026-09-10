// DATA UNDERSTANDING ENGINE — orquestrador (pontos 5-15, 21 do documento)
//
//   INPUT -> STRUCTURE (já feito no caller: já temos headers+rows)
//         -> PROFILING        (profiling.js)
//         -> SEMANTIC SCORING (semanticTypes.js)
//         -> CONFIDENCE       (confidence.js)
//         -> MAPPING          (aqui)
//
// A saída não é "field -> semanticType" (isso perderia informação e
// contradiria o ponto 12: "não deves apagar as colunas restantes"). A
// saída é uma lista de vereditos por campo, incluindo os UNKNOWN, para que
// o caller possa decidir o que fazer com cada um sem perder dados.
import { profileDataset } from "./profiling.js";
import { scoreDomainTypes, scoreGenericTypes } from "./semanticTypes.js";
import { buildFieldVerdict, DEFAULT_THRESHOLDS } from "./confidence.js";

/**
 * @param {string[]} headers
 * @param {object[]} rows raw row objects keyed by header
 * @param {object} [thresholds] override AUTO/REVIEW cutoffs (ponto 15)
 */
export function analyzeDataset(headers, rows, thresholds = DEFAULT_THRESHOLDS) {
  const { columns: profiles } = profileDataset(headers, rows);

  const fields = headers.map((header) => {
    const ctx = { headers, rows, profiles };
    // Domain vocabulary (sales/commerce) competes first, on its own — a
    // generic MEASURE/ENTITY must never outscore a clear domain match
    // (an earlier version of this engine let "ClientName" lose to a
    // generic "ENTITY" label purely because generic types don't dilute
    // their score across a header-match signal). Generic types are only
    // consulted when the domain vocabulary genuinely has nothing to offer.
    const domainRanked = scoreDomainTypes(header, profiles[header], ctx);
    const domainVerdict = buildFieldVerdict(header, domainRanked, thresholds);
    if (domainVerdict.status !== "UNKNOWN") return domainVerdict;

    const genericRanked = scoreGenericTypes(header, profiles[header], ctx);
    const genericBest = genericRanked[0];
    // Generic classification is deliberately capped at REVIEW — it's a
    // "here's an honest category, please confirm" fallback (ponto 2), not
    // a confident automatic decision, since it's built on type+
    // distribution alone with no vocabulary corroboration at all.
    if (genericBest.score >= 0.5) {
      return {
        header,
        semanticType: genericBest.semanticType,
        category: genericBest.category,
        generic: true,
        confidence: genericBest.score,
        margin: null,
        status: "REVIEW",
        reasons: genericBest.reasons,
        candidates: genericRanked.slice(0, 3),
      };
    }
    return domainVerdict; // stays UNKNOWN — genuinely nothing fits
  });

  // Ponto 9/13: se dois campos competem pelo mesmo tipo semântico (ex: duas
  // colunas ambas parecem "Revenue"), o vencedor é o de maior confiança; o
  // outro desce para REVIEW mesmo que tivesse passado o threshold de AUTO
  // sozinho — evitar dois campos mapeados silenciosamente para o mesmo
  // conceito de negócio, o que geraria dados duplicados/inconsistentes.
  const claimedBy = new Map(); // semanticType -> field with highest confidence so far
  for (const field of fields) {
    if (field.status === "UNKNOWN" || !field.semanticType) continue;
    const current = claimedBy.get(field.semanticType);
    if (!current || field.confidence > current.confidence) claimedBy.set(field.semanticType, field);
  }
  for (const field of fields) {
    if (field.status === "UNKNOWN" || !field.semanticType) continue;
    const winner = claimedBy.get(field.semanticType);
    if (winner !== field && field.status === "AUTO") {
      field.status = "REVIEW";
      field.reasons = [
        ...field.reasons,
        `Conflito: a coluna "${winner.header}" também foi detetada como ${field.semanticType} com maior confiança`,
      ];
    }
  }

  const suggestedMapping = {};
  const unknownFields = [];
  const genericFields = [];
  for (const field of fields) {
    if (field.status === "UNKNOWN") {
      unknownFields.push(field.header); // preservado, não descartado (ponto 21)
      continue;
    }
    if (field.generic) {
      // Ponto 2: um tipo genérico (MEASURE/ENTITY/CATEGORY/IDENTIFIER) dá
      // ao utilizador uma categoria honesta em vez de UNKNOWN, mas não é um
      // nome de campo do Unified Model — não deve poluir suggestedMapping
      // com chaves como "generic_measure" que nada a jusante entende.
      genericFields.push(field.header);
      continue;
    }
    // primeira coluna AUTO/REVIEW para cada tipo vence o slot de mapping;
    // as restantes ficam disponíveis em `fields` com o seu próprio veredito
    // mas não substituem a sugestão principal.
    const key = field.semanticType.toLowerCase();
    if (!suggestedMapping[key] || fields.find((f) => f.header === suggestedMapping[key])?.confidence < field.confidence) {
      suggestedMapping[key] = field.header;
    }
  }

  return {
    rowCount: rows.length,
    fields, // per-column verdict: semanticType, category, confidence, status, reasons
    suggestedMapping, // { customer: "Cliente", revenue: "Amount", ... } — this is now the ONLY mapping engine (columnDetection.js's header-only heuristic was removed; every caller — Excel and Postgres previews alike — goes through this one)
    unknownFields, // preserved raw columns the engine could not classify at all
    genericFields, // preserved raw columns classified only generically (MEASURE/ENTITY/CATEGORY/IDENTIFIER) — outside today's sales vocabulary but not thrown away
    summary: {
      auto: fields.filter((f) => f.status === "AUTO").length,
      review: fields.filter((f) => f.status === "REVIEW").length,
      unknown: fields.filter((f) => f.status === "UNKNOWN").length,
      generic: genericFields.length,
    },
  };
}
