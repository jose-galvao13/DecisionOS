import { describe, it, expect } from "vitest";
import { buildPortfolioAnalytics } from "../../src/services/portfolioAnalytics.js";
import { buildRateIndex } from "../../src/services/fxRates.js";
import { AI_TOOLS_SCHEMA, runTool, isPortfolioTool, PORTFOLIO_ADVISOR_GUARDRAILS } from "../../src/analytics-tools.js";

// Parte 2, FASE 4 — AI Advisor tools for the stock portfolio.
const raw = (ticker, quantidade, precoAtual, extra = {}) => ({ ticker, nome: null, sector: "Tech", pais: "US", tipoAtivo: null, quantidade, precoMedio: 1, precoAtual, moeda: "EUR", ...extra });
const portfolio = (positions, seriesByTicker = {}) => ({
  analytics: buildPortfolioAnalytics(positions, { defaultCurrency: "EUR", rateIndex: buildRateIndex([]) }),
  seriesByTicker,
});

describe("portfolio tools in AI_TOOLS_SCHEMA", () => {
  const byName = Object.fromEntries(AI_TOOLS_SCHEMA.map((t) => [t.name, t]));

  it("are registered with a schema Claude can call", () => {
    expect(byName.get_portfolio_summary.input_schema.type).toBe("object");
    expect(byName.simulate_sell_position.input_schema.required).toEqual(["ticker", "percent"]);
    expect(Object.keys(byName.simulate_sell_position.input_schema.properties)).toEqual(["ticker", "percent"]);
  });

  it("their descriptions frame them as descriptive, never as advice", () => {
    expect(byName.get_portfolio_summary.description).toMatch(/never to recommend buying or selling/i);
    expect(byName.simulate_sell_position.description).toMatch(/never as a suggestion to sell/i);
  });

  it("isPortfolioTool tells them apart from the sales tools", () => {
    expect(isPortfolioTool("get_portfolio_summary")).toBe(true);
    expect(isPortfolioTool("simulate_sell_position")).toBe(true);
    expect(isPortfolioTool("simulate_price_change")).toBe(false);
  });
});

describe("PORTFOLIO_ADVISOR_GUARDRAILS (appended to the system prompt by server.js)", () => {
  it("tells the model to describe risk and scenarios, never to recommend buying or selling, and to add the notice", () => {
    expect(PORTFOLIO_ADVISOR_GUARDRAILS).toMatch(/Describe risk and scenarios only/);
    expect(PORTFOLIO_ADVISOR_GUARDRAILS).toMatch(/NEVER recommend, suggest or advise buying, selling/);
    expect(PORTFOLIO_ADVISOR_GUARDRAILS).toMatch(/not financial advice/);
    expect(PORTFOLIO_ADVISOR_GUARDRAILS).toMatch(/get_portfolio_summary/);
    expect(PORTFOLIO_ADVISOR_GUARDRAILS).toMatch(/simulate_sell_position/);
  });
});

describe("runTool — get_portfolio_summary", () => {
  it("returns the portfolio's own numbers: value, HHI, top positions, exposure, VaR status and the notice", () => {
    const p = portfolio([raw("AAA", 6, 100), raw("BBB", 3, 100, { sector: "Energy" }), raw("CCC", 1, 100, { sector: null })]);
    const r = runTool("get_portfolio_summary", {}, { portfolio: p });
    expect(r.error).toBeUndefined();
    expect(r.currency).toBe("EUR");
    expect(r.totals.value).toBe(1000);
    expect(r.concentration.hhi).toBeCloseTo(0.46, 4);
    expect(r.concentration.top3.map((x) => [x.ticker, x.pesoPct])).toEqual([["AAA", 60], ["BBB", 30], ["CCC", 10]]);
    expect(r.positions[0]).toMatchObject({ ticker: "AAA", pesoPct: 60 });
    expect(r.exposures.bySector.map((e) => e.key)).toEqual(["Tech", "Energy", "N/D"]);
    expect(r.var95.insufficientData).toBe(true); // no price history given -> says so, no invented number
    expect(r.var95.pct).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain("sector_nd");
    expect(r.disclaimer).toMatch(/not financial advice/i);
  });

  it("works with no sales analytics at all (portfolio-only organisation)", () => {
    const r = runTool("get_portfolio_summary", {}, { analytics: null, portfolio: portfolio([raw("AAA", 1, 100)]) });
    expect(r.totals.positions).toBe(1);
  });

  it("returns a clear error (not a crash) when there is no portfolio", () => {
    expect(runTool("get_portfolio_summary", {}, { portfolio: null }).error).toMatch(/no stock portfolio/);
    expect(runTool("get_portfolio_summary", {}, { portfolio: portfolio([]) }).error).toMatch(/no stock portfolio/);
    expect(runTool("simulate_sell_position", { ticker: "AAA", percent: 10 }, {}).error).toMatch(/no stock portfolio/);
  });
});

describe("runTool — simulate_sell_position", () => {
  it("runs the same engine the Decision Simulator uses", () => {
    const p = portfolio([raw("AAA", 6, 100), raw("BBB", 3, 100), raw("CCC", 1, 100)]);
    const r = runTool("simulate_sell_position", { ticker: "AAA", percent: 50 }, { portfolio: p });
    expect(r.current.hhi).toBeCloseTo(0.46, 4);
    expect(r.scenario.hhi).toBeCloseTo(0.3878, 4);
    expect(r.disclaimer).toMatch(/not financial advice/i);
  });

  it("surfaces the engine's error for an unknown ticker or a bad percent instead of throwing", () => {
    const p = portfolio([raw("AAA", 1, 100)]);
    expect(runTool("simulate_sell_position", { ticker: "ZZZ", percent: 10 }, { portfolio: p }).error).toMatch(/unknown ticker/);
    expect(runTool("simulate_sell_position", { ticker: "AAA", percent: 0 }, { portfolio: p }).error).toMatch(/percent/);
    expect(runTool("simulate_sell_position", {}, { portfolio: p }).error).toBeTruthy();
  });
});

describe("runTool — sales tools keep working and degrade clearly", () => {
  it("a sales tool with no sales analytics says so instead of 'tool execution failed'", () => {
    expect(runTool("get_company_overview", {}, { analytics: null }).error).toMatch(/no sales transactions/);
  });
});
