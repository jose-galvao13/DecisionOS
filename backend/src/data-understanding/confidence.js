// FASE 5 — CONFIDENCE (pontos 3, 13, 15 do documento)
//
// "95%+ automático, 75-94% revisão, <75% perguntar. Mas não fixes estes
// valores para sempre. Devem ser configuráveis. E mais importante: não
// transformar baixa confiança em uma decisão falsa."
//
// PONTO 3 (competição entre candidatos) acrescenta uma segunda condição
// para AUTO, além do score absoluto: a MARGEM sobre o segundo candidato.
//   Revenue 87% / Cost 84%  -> margem 3%  -> REVIEW, mesmo que o score
//                                            absoluto por si só pudesse
//                                            parecer razoável
//   Revenue 97% / Cost 41%  -> margem 56% -> AUTO
// Um score alto sozinho não basta: se o segundo melhor candidato está
// "colado" ao primeiro, isso é sinal de ambiguidade genuína (duas
// interpretações plausíveis), não de confiança.

export const DEFAULT_THRESHOLDS = {
  auto: 0.95,
  review: 0.75,
  minMargin: 0.12, // mínimo de distância ao 2º candidato para AUTO
};

/**
 * @param {number} score  do candidato vencedor
 * @param {number} margin score do vencedor - score do 2º colocado
 */
export function classifyConfidence(score, margin, thresholds = DEFAULT_THRESHOLDS) {
  if (score >= thresholds.auto) {
    return margin >= thresholds.minMargin ? "AUTO" : "REVIEW";
  }
  if (score >= thresholds.review) return "REVIEW";
  return "UNKNOWN";
}

/**
 * Turns the ranked list of {semanticType, score, reasons, category} (from
 * semanticTypes.scoreColumn) into the field-level verdict the UI shows.
 */
export function buildFieldVerdict(header, ranked, thresholds = DEFAULT_THRESHOLDS) {
  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = runnerUp ? round(best.score - runnerUp.score) : best.score;
  const status = classifyConfidence(best.score, margin, thresholds);

  if (status === "UNKNOWN") {
    return {
      header,
      semanticType: null,
      category: null,
      confidence: best.score,
      margin,
      status: "UNKNOWN",
      reasons: [],
      message:
        "Não foi possível determinar com confiança o significado desta coluna. " +
        "Fica preservada como campo desconhecido em vez de ser adivinhada.",
      candidates: ranked.slice(0, 3),
    };
  }

  const reasons = [...best.reasons];
  if (best.score >= thresholds.auto && status === "REVIEW" && runnerUp) {
    reasons.push(
      `Confiança alta (${Math.round(best.score * 100)}%), mas "${runnerUp.semanticType}" ficou muito próximo ` +
        `(${Math.round(runnerUp.score * 100)}%) — margem insuficiente para automático`
    );
  }

  return {
    header,
    semanticType: best.semanticType,
    category: best.category,
    generic: best.generic,
    confidence: best.score,
    margin,
    status,
    reasons,
    candidates: ranked.slice(0, 3),
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}
