import { describe, it, expect } from "vitest";
import {
  hasPrice,
  computeUnrealizedPnL,
  convertToDefaultCurrency,
  computeWeights,
  computeConcentration,
  computeExposureByDimension,
  computeExposures,
  buildPortfolioAnalytics,
} from "../../src/services/portfolioAnalytics.js";
import { buildRateIndex } from "../../src/services/fxRates.js";

// Helper to build a raw position the same shape loadAggregatedHoldings()
// (portfolio.routes.js) produces.
function pos({ ticker, quantidade, precoMedio, precoAtual = null, moeda = "EUR", sector = null, pais = null, nome = null, tipoAtivo = null }) {
  return { ticker, nome, sector, pais, tipoAtivo, quantidade, precoMedio, precoAtual, moeda };
}

describe("hasPrice / computeUnrealizedPnL", () => {
  it("is false / null for a position with no current price", () => {
    const p = pos({ ticker: "AAA", quantidade: 10, precoMedio: 10 });
    expect(hasPrice(p)).toBe(false);
    expect(computeUnrealizedPnL(p)).toBeNull();
  });

  it("computes quantidade x (precoAtual - precoMedio) by hand", () => {
    const p = pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 15 });
    expect(hasPrice(p)).toBe(true);
    expect(computeUnrealizedPnL(p)).toBe(50); // 10 * (15-10)
  });

  it("handles a loss the same way", () => {
    const p = pos({ ticker: "BBB", quantidade: 5, precoMedio: 20, precoAtual: 18 });
    expect(computeUnrealizedPnL(p)).toBe(-10); // 5 * (18-20)
  });

  it("returns exactly 0 (not null) when price hasn't moved", () => {
    const p = pos({ ticker: "CCC", quantidade: 20, precoMedio: 5, precoAtual: 5 });
    expect(computeUnrealizedPnL(p)).toBe(0);
  });
});

describe("convertToDefaultCurrency", () => {
  const rateIndex = buildRateIndex([
    { currency: "USD", rate_to_default: 0.9, effective_date: "2024-01-01" },
  ]);

  it("passes a position already in the default currency through with rate 1", () => {
    const [out] = convertToDefaultCurrency(
      [pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 15, moeda: "EUR" })],
      "EUR", rateIndex
    );
    expect(out.valorAtualConvertido).toBe(150);
    expect(out.fxRate).toBe(1);
    expect(out.semTaxaCambio).toBe(false);
  });

  it("converts a priced position using the org's fx rate", () => {
    const [out] = convertToDefaultCurrency(
      [pos({ ticker: "EEE", quantidade: 10, precoMedio: 80, precoAtual: 100, moeda: "USD" })],
      "EUR", rateIndex
    );
    // valor in USD = 10 * 100 = 1000; converted = 1000 * 0.9 = 900
    expect(out.valorAtualConvertido).toBe(900);
    expect(out.fxRate).toBe(0.9);
    expect(out.semTaxaCambio).toBe(false);
  });

  it("flags a priced position in a currency with no fx rate on file, without guessing a value", () => {
    const [out] = convertToDefaultCurrency(
      [pos({ ticker: "FFF", quantidade: 10, precoMedio: 5, precoAtual: 6, moeda: "GBP" })],
      "EUR", rateIndex
    );
    expect(out.valorAtualConvertido).toBeNull();
    expect(out.semTaxaCambio).toBe(true);
  });

  it("leaves a 'sem preço' position untouched — nothing to convert", () => {
    const [out] = convertToDefaultCurrency(
      [pos({ ticker: "DDD", quantidade: 10, precoMedio: 10, moeda: "USD" })],
      "EUR", rateIndex
    );
    expect(out.valorAtualConvertido).toBeNull();
    expect(out.semTaxaCambio).toBe(false);
  });
});

describe("computeWeights", () => {
  it("weighs three same-currency positions by hand", () => {
    const converted = convertToDefaultCurrency(
      [
        pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 15 }), // valor 150
        pos({ ticker: "BBB", quantidade: 5, precoMedio: 20, precoAtual: 18 }),  // valor 90
        pos({ ticker: "CCC", quantidade: 20, precoMedio: 5, precoAtual: 5 }),   // valor 100
      ],
      "EUR", buildRateIndex([])
    );
    const weighted = computeWeights(converted);
    const byTicker = Object.fromEntries(weighted.map((p) => [p.ticker, p.pesoPct]));
    // total = 340
    expect(byTicker.AAA).toBeCloseTo((150 / 340) * 100, 6);
    expect(byTicker.BBB).toBeCloseTo((90 / 340) * 100, 6);
    expect(byTicker.CCC).toBeCloseTo((100 / 340) * 100, 6);
  });

  it("excludes an unpriced position from the denominator (not counted as 0%)", () => {
    const converted = convertToDefaultCurrency(
      [
        pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 10 }), // valor 100
        pos({ ticker: "DDD", quantidade: 10, precoMedio: 10 }),                 // sem preço
      ],
      "EUR", buildRateIndex([])
    );
    const weighted = computeWeights(converted);
    const aaa = weighted.find((p) => p.ticker === "AAA");
    const ddd = weighted.find((p) => p.ticker === "DDD");
    expect(aaa.pesoPct).toBe(100); // the only priced position gets the whole weight
    expect(ddd.pesoPct).toBeNull();
  });
});

describe("computeConcentration", () => {
  it("computes HHI, effective N and top3 by hand for a 3-position portfolio", () => {
    const converted = convertToDefaultCurrency(
      [
        pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 15 }), // 150
        pos({ ticker: "BBB", quantidade: 5, precoMedio: 20, precoAtual: 18 }),  // 90
        pos({ ticker: "CCC", quantidade: 20, precoMedio: 5, precoAtual: 5 }),   // 100
      ],
      "EUR", buildRateIndex([])
    );
    const weighted = computeWeights(converted);
    const { hhi, effectiveN, top3, top3Pct } = computeConcentration(weighted);

    // weights as fractions: 150/340, 90/340, 100/340
    const w1 = 150 / 340, w2 = 90 / 340, w3 = 100 / 340;
    const expectedHhi = w1 ** 2 + w2 ** 2 + w3 ** 2;
    expect(hhi).toBeCloseTo(expectedHhi, 10);
    expect(effectiveN).toBeCloseTo(1 / expectedHhi, 10);
    expect(top3).toHaveLength(3); // fewer than 3 positions total, so top3 = all of them
    expect(top3Pct).toBeCloseTo(100, 6);
    expect(top3[0].ticker).toBe("AAA"); // largest weight first
  });

  it("a single fully-concentrated position gives HHI = 1 and effective N = 1", () => {
    const converted = convertToDefaultCurrency(
      [pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 10 })],
      "EUR", buildRateIndex([])
    );
    const { hhi, effectiveN } = computeConcentration(computeWeights(converted));
    expect(hhi).toBe(1);
    expect(effectiveN).toBe(1);
  });

  it("four equally-weighted positions give HHI = 0.25 and effective N = 4", () => {
    const raw = ["A", "B", "C", "D"].map((t) => pos({ ticker: t, quantidade: 10, precoMedio: 10, precoAtual: 10 }));
    const { hhi, effectiveN } = computeConcentration(computeWeights(convertToDefaultCurrency(raw, "EUR", buildRateIndex([]))));
    expect(hhi).toBeCloseTo(0.25, 10);
    expect(effectiveN).toBeCloseTo(4, 10);
  });

  it("returns HHI 0 / effective N 0 when nothing is priced", () => {
    const raw = [pos({ ticker: "AAA", quantidade: 10, precoMedio: 10 })];
    const { hhi, effectiveN, top3 } = computeConcentration(computeWeights(convertToDefaultCurrency(raw, "EUR", buildRateIndex([]))));
    expect(hhi).toBe(0);
    expect(effectiveN).toBe(0);
    expect(top3).toHaveLength(0);
  });
});

describe("computeExposureByDimension / computeExposures", () => {
  const raw = [
    pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 15, sector: "Tech", pais: "US", moeda: "EUR" }),   // 150
    pos({ ticker: "BBB", quantidade: 5, precoMedio: 20, precoAtual: 18, sector: "Tech", pais: "PT", moeda: "EUR" }),    // 90
    pos({ ticker: "CCC", quantidade: 20, precoMedio: 5, precoAtual: 5, sector: "Health", pais: "US", moeda: "EUR" }),   // 100
  ];
  const weighted = computeWeights(convertToDefaultCurrency(raw, "EUR", buildRateIndex([])));

  it("sums weight by sector", () => {
    const bySector = computeExposureByDimension(weighted, "sector");
    const map = Object.fromEntries(bySector.map((e) => [e.key, e.pesoPct]));
    expect(map.Tech).toBeCloseTo(((150 + 90) / 340) * 100, 6);
    expect(map.Health).toBeCloseTo((100 / 340) * 100, 6);
  });

  it("sums weight by country", () => {
    const byCountry = computeExposureByDimension(weighted, "pais");
    const map = Object.fromEntries(byCountry.map((e) => [e.key, e.pesoPct]));
    expect(map.US).toBeCloseTo(((150 + 100) / 340) * 100, 6);
    expect(map.PT).toBeCloseTo((90 / 340) * 100, 6);
  });

  it("buckets a missing sector/country under 'N/D' rather than dropping the position", () => {
    const withMissing = computeWeights(
      convertToDefaultCurrency(
        [...raw, pos({ ticker: "DDD", quantidade: 10, precoMedio: 5, precoAtual: 5, moeda: "EUR" })],
        "EUR", buildRateIndex([])
      )
    );
    const bySector = computeExposureByDimension(withMissing, "sector");
    const nd = bySector.find((e) => e.key === "N/D");
    expect(nd).toBeDefined();
    expect(nd.pesoPct).toBeCloseTo((50 / 390) * 100, 6); // DDD = 10*5 = 50, new total = 340+50
  });

  it("computeExposures returns all three dimensions at once", () => {
    const exposures = computeExposures(weighted);
    expect(exposures).toHaveProperty("byCurrency");
    expect(exposures).toHaveProperty("bySector");
    expect(exposures).toHaveProperty("byCountry");
    // single currency (EUR) portfolio -> 100% exposure to it
    expect(exposures.byCurrency[0].key).toBe("EUR");
    expect(exposures.byCurrency[0].pesoPct).toBeCloseTo(100, 6);
  });
});

describe("buildPortfolioAnalytics — full pipeline on a small mixed portfolio", () => {
  const rateIndex = buildRateIndex([
    { currency: "USD", rate_to_default: 0.9, effective_date: "2024-01-01" },
  ]);

  const raw = [
    pos({ ticker: "AAA", quantidade: 10, precoMedio: 10, precoAtual: 15, moeda: "EUR", sector: "Tech", pais: "US" }), // valor 150 EUR
    pos({ ticker: "BBB", quantidade: 5, precoMedio: 20, precoAtual: 18, moeda: "EUR", sector: "Tech", pais: "PT" }),  // valor 90 EUR
    pos({ ticker: "EEE", quantidade: 10, precoMedio: 80, precoAtual: 100, moeda: "USD" }),                            // valor 1000 USD -> 900 EUR
    pos({ ticker: "DDD", quantidade: 10, precoMedio: 10, moeda: "EUR" }),                                             // sem preço
    pos({ ticker: "FFF", quantidade: 10, precoMedio: 5, precoAtual: 6, moeda: "GBP" }),                               // sem taxa de câmbio
  ];

  const result = buildPortfolioAnalytics(raw, { defaultCurrency: "EUR", rateIndex });

  it("marks unpriced and unconvertible positions and excludes them from weights", () => {
    const byTicker = Object.fromEntries(result.positions.map((p) => [p.ticker, p]));
    expect(byTicker.DDD.semPreco).toBe(true);
    expect(byTicker.DDD.pesoPct).toBeNull();
    expect(byTicker.FFF.semTaxaCambio).toBe(true);
    expect(byTicker.FFF.pesoPct).toBeNull();
  });

  it("sizes the priced/convertible total value correctly (150 + 90 + 900 = 1140 EUR)", () => {
    expect(result.totals.valorAtual).toBeCloseTo(1140, 6);
  });

  it("computes unrealized P&L per position in its own currency", () => {
    const byTicker = Object.fromEntries(result.positions.map((p) => [p.ticker, p]));
    expect(byTicker.AAA.pnlNaoRealizado).toBe(50);
    expect(byTicker.BBB.pnlNaoRealizado).toBe(-10);
    expect(byTicker.EEE.pnlNaoRealizado).toBe(200); // 10 * (100-80) USD
  });

  it("raises visible warnings for both the unpriced and the unconvertible position", () => {
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("sem_preco");
    expect(codes).toContain("sem_taxa_cambio");
    const semPreco = result.warnings.find((w) => w.code === "sem_preco");
    expect(semPreco.tickers).toEqual(["DDD"]);
    const semTaxa = result.warnings.find((w) => w.code === "sem_taxa_cambio");
    expect(semTaxa.tickers).toEqual(["FFF"]);
  });

  it("never invents sector/pais — missing values surface as N/D and a warning", () => {
    const byTicker = Object.fromEntries(result.positions.map((p) => [p.ticker, p]));
    expect(byTicker.EEE.sector).toBe("N/D");
    expect(byTicker.EEE.pais).toBe("N/D");
    const codes = result.warnings.map((w) => w.code);
    expect(codes).toContain("sector_nd");
    expect(codes).toContain("pais_nd");
  });

  it("concentration only counts priced/convertible positions (3 of 5)", () => {
    expect(result.totals.posicoesComPreco).toBe(3);
    expect(result.totals.posicoesSemPreco).toBe(2);
    expect(result.concentration.top3).toHaveLength(3);
  });
});
