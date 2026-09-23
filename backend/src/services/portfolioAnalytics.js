/* ---------------------------------------------------------------
   PORTFOLIO ANALYTICS — Parte 2, FASE 2 ("Análise sem preços ao
   vivo"). Pure, DB-free functions operating on the same position
   shape GET /api/portfolio/holdings already returns (see
   routes/portfolio.routes.js), so routes/tests can feed it plain
   objects with no mocking required.

   Design rules from the spec, enforced here rather than just in the
   route:
     - A position with no known current price is "sem preço": it is
       marked as such and left OUT of every weight/concentration/
       exposure calculation (never guessed at with cost as a stand-in
       for value — that's a route-layer choice made elsewhere, not
       an analytics one).
     - sector/pais missing on a position becomes the literal "N/D"
       bucket in exposure — never dropped, never invented.
     - Currency conversion reuses fxRates.js's buildRateIndex/
       rateAsOf exactly like analyticsEngine.js does for
       transactions; a position whose currency has no rate on file
       is treated the same as "sem preço" (can't size it in the
       portfolio's own currency), with its own warning.
----------------------------------------------------------------*/
import { rateAsOf } from "./fxRates.js";
import { invalidateByPrefix } from "./cache.js";

/** GET /api/portfolio/analytics (routes/portfolio.routes.js) caches its
 *  result under this prefix (see cache.js) for 60s. Called after
 *  anything that changes holdings or prices for an org — a completed
 *  import (worker.js) or a manual price update/import delete
 *  (portfolio.routes.js) — so the endpoint never serves numbers from
 *  before that write for the rest of the TTL. Kept here, not in the
 *  route file, so worker.js (which has no reason to import an Express
 *  router) can call it too. */
export function invalidatePortfolioAnalyticsCache(orgId) {
  invalidateByPrefix(`portfolio-analytics:${orgId}`);
}

/** True when a position's current price is known. Centralised so every
 *  function below agrees on what "sem preço" means (== null/undefined,
 *  not <= 0 — a price of 0 would still fail the security_prices CHECK
 *  constraint upstream, so this only ever sees "missing" as null). */
export function hasPrice(position) {
  return position.precoAtual != null;
}

/**
 * Unrealized P&L for one position: quantidade × (preço atual − preço
 * médio), in the position's own (uncounverted) currency. Returns null
 * for a "sem preço" position — never 0, since 0 would misleadingly read
 * as "flat", not "unknown".
 */
export function computeUnrealizedPnL(position) {
  if (!hasPrice(position)) return null;
  return position.quantidade * (position.precoAtual - position.precoMedio);
}

/**
 * Converts each position's current value (quantidade × preço atual) into
 * `defaultCurrency` using the org's fx_rates, exactly like
 * analyticsEngine.js's loadOrgTransactions() does for transactions:
 * same currency needs no rate, a covered currency is converted with the
 * rate in effect as of `asOfDate`, an uncovered one is left unconverted
 * with a flag so callers can warn instead of silently mis-sizing it.
 *
 * `rateIndex` is fxRates.js's buildRateIndex(rateRows) output — built
 * once by the caller and passed in here, not rebuilt per position.
 *
 * Positions with no price at all pass through untouched (still "sem
 * preço"; there's nothing to convert).
 */
export function convertToDefaultCurrency(positions, defaultCurrency, rateIndex, asOfDate = new Date()) {
  return positions.map((p) => {
    if (!hasPrice(p)) {
      return { ...p, valorAtualConvertido: null, semTaxaCambio: false };
    }
    const valorAtual = p.quantidade * p.precoAtual;
    if (p.moeda === defaultCurrency) {
      return { ...p, valorAtualConvertido: valorAtual, fxRate: 1, semTaxaCambio: false };
    }
    const rate = rateAsOf(rateIndex, p.moeda, asOfDate);
    if (rate == null) {
      // Priced, but in a currency this org has never set a rate for —
      // can't be sized in the portfolio's own currency, so it's excluded
      // from weights/concentration/exposure just like a "sem preço"
      // position, with a distinct warning (see buildPortfolioAnalytics).
      return { ...p, valorAtualConvertido: null, fxRate: null, semTaxaCambio: true };
    }
    return { ...p, valorAtualConvertido: valorAtual * rate, fxRate: rate, semTaxaCambio: false };
  });
}

/**
 * Adds `pesoPct` (0–100) to each position: its share of the total value
 * across every position that HAS a converted value. Positions without
 * one (no price, or no fx rate) get `pesoPct: null` and are excluded
 * from the denominator — "fora dos pesos" per the spec, not counted as
 * 0%, which would understate everyone else's weight.
 */
export function computeWeights(positions) {
  const total = positions.reduce((sum, p) => sum + (p.valorAtualConvertido ?? 0), 0);
  return positions.map((p) => ({
    ...p,
    pesoPct: p.valorAtualConvertido != null && total > 0 ? (p.valorAtualConvertido / total) * 100 : null,
  }));
}

/**
 * Concentration over the weighted (priced, convertible) positions only:
 *   - top3: the 3 largest positions by weight (fewer if the portfolio
 *     has fewer than 3 priced positions), with their combined weight.
 *   - HHI = Σ(weight²), weight as a *fraction* (0–1), so HHI ranges
 *     0–1 (a single 100%-weight position gives HHI = 1, not 10000 —
 *     the "index points" convention (0–10000) some regulators use is
 *     left to the caller/UI to rescale if ever wanted).
 *   - effectiveN = 1 / HHI, "the number of equally-weighted positions
 *     that would give this same HHI" — the standard reading of the
 *     inverse HHI. 0 when there are no priced positions at all (HHI
 *     undefined, not divide-by-zero).
 */
export function computeConcentration(weightedPositions) {
  const priced = weightedPositions.filter((p) => p.pesoPct != null);
  const hhi = priced.reduce((sum, p) => sum + (p.pesoPct / 100) ** 2, 0);
  const effectiveN = hhi > 0 ? 1 / hhi : 0;
  const top3 = [...priced].sort((a, b) => b.pesoPct - a.pesoPct).slice(0, 3);
  const top3Pct = top3.reduce((sum, p) => sum + p.pesoPct, 0);
  return {
    hhi,
    effectiveN,
    top3: top3.map((p) => ({ ticker: p.ticker, nome: p.nome, pesoPct: p.pesoPct })),
    top3Pct,
  };
}

/**
 * Weight-based exposure by one dimension ("moeda" | "sector" | "pais"),
 * over priced/convertible positions only. A missing value on that
 * dimension (sector/pais not present in the source file) buckets under
 * the literal "N/D" per the spec — never dropped from the total, so the
 * exposure percentages for one dimension still sum to ~100% of the
 * priced portfolio.
 */
export function computeExposureByDimension(weightedPositions, dimension) {
  const priced = weightedPositions.filter((p) => p.pesoPct != null);
  const byKey = new Map();
  for (const p of priced) {
    const key = (p[dimension] ?? "").toString().trim() || "N/D";
    byKey.set(key, (byKey.get(key) || 0) + p.pesoPct);
  }
  return [...byKey.entries()]
    .map(([key, pesoPct]) => ({ key, pesoPct }))
    .sort((a, b) => b.pesoPct - a.pesoPct);
}

/** All three exposure dimensions the spec asks for, in one call. */
export function computeExposures(weightedPositions) {
  return {
    byCurrency: computeExposureByDimension(weightedPositions, "moeda"),
    bySector: computeExposureByDimension(weightedPositions, "sector"),
    byCountry: computeExposureByDimension(weightedPositions, "pais"),
  };
}

/**
 * Full pipeline: raw positions (as GET /holdings' query already shapes
 * them: ticker/nome/sector/pais/quantidade/precoMedio/moeda/precoAtual,
 * `precoAtual` null meaning no quote) -> converted, weighted, with
 * concentration, exposures, totals and visible warnings.
 *
 * Never invents a value: a position that can't be priced or can't be
 * converted contributes to `totals.valorSemPreco`/`totals.custoSemPreco`
 * bookkeeping and a warning, but never to weights/HHI/exposure.
 */
export function buildPortfolioAnalytics(rawPositions, { defaultCurrency, rateIndex, asOfDate = new Date() }) {
  const converted = convertToDefaultCurrency(rawPositions, defaultCurrency, rateIndex, asOfDate);
  const weighted = computeWeights(converted);
  const concentration = computeConcentration(weighted);
  const exposures = computeExposures(weighted);

  const positions = weighted.map((p) => {
    const pnlOriginal = computeUnrealizedPnL(p);
    return {
      ticker: p.ticker,
      nome: p.nome,
      sector: p.sector || "N/D",
      pais: p.pais || "N/D",
      tipoAtivo: p.tipoAtivo || "N/D",
      moeda: p.moeda,
      quantidade: p.quantidade,
      precoMedio: p.precoMedio,
      precoAtual: p.precoAtual,
      custoTotal: p.quantidade * p.precoMedio,
      valorAtual: hasPrice(p) ? p.quantidade * p.precoAtual : null,
      valorAtualConvertido: p.valorAtualConvertido,
      pnlNaoRealizado: pnlOriginal,
      pesoPct: p.pesoPct,
      semPreco: !hasPrice(p),
      semTaxaCambio: p.semTaxaCambio,
    };
  });

  const semPrecoTickers = positions.filter((p) => p.semPreco).map((p) => p.ticker);
  const semTaxaTickers = positions.filter((p) => p.semTaxaCambio).map((p) => p.ticker);
  const semSectorCount = positions.filter((p) => p.sector === "N/D").length;
  const semPaisCount = positions.filter((p) => p.pais === "N/D").length;

  const valorTotalConvertido = positions.reduce((sum, p) => sum + (p.valorAtualConvertido ?? 0), 0);
  const custoTotalPriced = positions.filter((p) => !p.semPreco && !p.semTaxaCambio).reduce((s, p) => s + p.custoTotal, 0);
  const custoTotalSemPreco = positions.filter((p) => p.semPreco || p.semTaxaCambio).reduce((s, p) => s + p.custoTotal, 0);
  const pnlTotalConvertido = positions.reduce((sum, p) => {
    if (p.semPreco || p.semTaxaCambio || p.pnlNaoRealizado == null) return sum;
    // pnlNaoRealizado is in the position's own currency; scale it by the
    // same fx rate used for its value so the total is in defaultCurrency.
    const rate = p.moeda === defaultCurrency ? 1 : rateAsOf(rateIndex, p.moeda, asOfDate);
    return sum + (rate != null ? p.pnlNaoRealizado * rate : 0);
  }, 0);

  const warnings = [];
  if (semPrecoTickers.length) {
    warnings.push({
      code: "sem_preco",
      message: `${semPrecoTickers.length} posições sem preço atual — excluídas dos pesos e da concentração`,
      tickers: semPrecoTickers,
    });
  }
  if (semTaxaTickers.length) {
    warnings.push({
      code: "sem_taxa_cambio",
      message: `${semTaxaTickers.length} posições com preço mas sem taxa de câmbio definida para converter para ${defaultCurrency}`,
      tickers: semTaxaTickers,
    });
  }
  if (semSectorCount) warnings.push({ code: "sector_nd", message: `${semSectorCount} posições sem sector (N/D)`, count: semSectorCount });
  if (semPaisCount) warnings.push({ code: "pais_nd", message: `${semPaisCount} posições sem país (N/D)`, count: semPaisCount });

  return {
    defaultCurrency,
    positions,
    totals: {
      valorAtual: valorTotalConvertido,
      custoTotalComPreco: custoTotalPriced,
      custoTotalSemPreco,
      pnlNaoRealizado: pnlTotalConvertido,
      pnlNaoRealizadoPct: custoTotalPriced ? (pnlTotalConvertido / custoTotalPriced) * 100 : null,
      posicoes: positions.length,
      posicoesComPreco: positions.length - semPrecoTickers.length - semTaxaTickers.length,
      posicoesSemPreco: semPrecoTickers.length + semTaxaTickers.length,
    },
    concentration,
    exposures,
    warnings,
  };
}
