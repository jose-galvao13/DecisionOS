/* ---------------------------------------------------------------
   FASE 8 — "Dataset limits claros": one place both the import path
   and the analytics path read from, so the limit is documented and
   consistent instead of a silent truncation buried in a query. When
   a source is too big we FAIL the job with a clear message rather
   than importing a silently-truncated subset of the customer's data.
----------------------------------------------------------------*/
export const MAX_IMPORT_ROWS = Number(process.env.DATASET_MAX_ROWS || 200_000);

// Analytics loads the whole org's transactions into memory to compute
// aggregates (analyticsEngine.js) — same cap, same rationale.
export const ANALYTICS_ROW_CAP = MAX_IMPORT_ROWS;

// Parte 2, FASE 3 — "mínimo de observações (por exemplo >= 60; abaixo
// disso, 'dados insuficientes')". One place both services/riskAnalytics.js
// and the frontend's warning copy read from, so the threshold can't drift
// between the number that decides the flag and the number shown to the
// person in the message.
export const RISK_MIN_OBSERVATIONS = Number(process.env.RISK_MIN_OBSERVATIONS || 60);

// Parte 2, FASE 4 — alerta de concentração da carteira (notifications.js).
// Dois limiares, lidos aqui para o número que dispara o alerta e o número
// mostrado na mensagem nunca divergirem:
//   - uma única posição acima de PORTFOLIO_ALERT_MAX_POSITION_PCT (%);
//   - HHI acima de PORTFOLIO_ALERT_HHI (fração 0–1, a mesma convenção de
//     portfolioAnalytics.computeConcentration; 0.20 ≈ menos de 5 posições
//     efetivas).
// Nota: HHI ≤ peso da maior posição, por isso o limiar do HHI só é
// redundante se for ≥ ao da posição — com 0.20 vs 25% o HHI apanha também
// carteiras de várias posições grandes (ex.: 4 × 24%) que nenhuma regra
// "por posição" apanharia.
export const PORTFOLIO_ALERT_MAX_POSITION_PCT = Number(process.env.PORTFOLIO_ALERT_MAX_POSITION_PCT || 25);
export const PORTFOLIO_ALERT_HHI = Number(process.env.PORTFOLIO_ALERT_HHI || 0.2);
