import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeModeProvider } from "../../src/lib/theme";
import { LangProvider } from "../../src/lib/i18n";
import { ToastProvider } from "../../src/components/ui";

vi.mock("../../src/api/client", () => ({
  apiFetch: vi.fn(),
  apiUpload: vi.fn(),
  apiDownload: vi.fn(),
  saveBlob: vi.fn(),
  pollJob: vi.fn(),
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
}));
import { apiFetch } from "../../src/api/client";
import DecisionSimulator from "../../src/pages/Decisions/DecisionSimulator";

// Parte 2, FASE 4 — the "Carteira de ações" tab of the Decision Simulator.
const wrap = (ui) => render(<ThemeModeProvider><LangProvider><ToastProvider>{ui}</ToastProvider></LangProvider></ThemeModeProvider>);

const position = (ticker, pesoPct, over = {}) => ({ ticker, nome: `${ticker} Inc`, moeda: "EUR", pesoPct, semPreco: false, semTaxaCambio: false, ...over });
const portfolioAnalytics = {
  defaultCurrency: "EUR",
  positions: [position("BBB", 30), position("AAA", 60), position("CCC", 10), position("NOP", null, { semPreco: true })],
};

const var95 = (pct, amount) => ({ pct, amount, insufficientData: pct == null, observations: 8, coveredWeightPct: 100, coveredTickers: [], excludedTickers: [], from: "2024-01-02", to: "2024-01-09" });
function simulation(over = {}) {
  return {
    label: "Sell 25% of AAA", ticker: "AAA", nome: "AAA Inc", percent: 25, currency: "EUR", proceeds: 150,
    current: { totalValue: 1000, positions: 3, hhi: 0.46, effectiveN: 2.17, top3: [], top3Pct: 100, largestPositionPct: 60, var95: var95(6, 60) },
    scenario: { totalValue: 850, positions: 3, hhi: 0.4118, effectiveN: 2.43, top3: [], top3Pct: 100, largestPositionPct: 52.94, var95: var95(5.29, 45) },
    weights: [
      { ticker: "AAA", nome: "AAA Inc", pesoBeforePct: 60, pesoAfterPct: 52.94, valueBefore: 600, valueAfter: 450 },
      { ticker: "BBB", nome: "BBB Inc", pesoBeforePct: 30, pesoAfterPct: 35.29, valueBefore: 300, valueAfter: 300 },
      { ticker: "CCC", nome: "CCC Inc", pesoBeforePct: 10, pesoAfterPct: 11.76, valueBefore: 100, valueAfter: 100 },
    ],
    impact: { valueDelta: -150, positionWeightDeltaPP: -7.06, hhiDelta: -0.0482, effectiveNDelta: 0.26, largestPositionDeltaPP: -7.06, var95DeltaPP: -0.71, var95AmountDelta: -15 },
    warnings: [],
    ...over,
  };
}

const levers = {
  label: "levers", current: {}, scenario: {},
  impact: { revenueDelta: 1000, profitDelta: 500, marginPPDelta: 0.5, customersDeltaPct: -1, estimatedRange: { low: 100, high: 900 } },
  assumptions: { levers: [] }, risk: "low", confidence: "high", evidence: { monthsCovered: 6, transactions: 100 }, rangeMethodology: "method",
};

let simulateImpl;
beforeEach(() => {
  apiFetch.mockReset();
  simulateImpl = () => simulation();
  apiFetch.mockImplementation(async (url, opts) => {
    if (url === "/api/portfolio/analytics") return portfolioAnalytics;
    if (url === "/api/simulate") return opts.body.type === "sell_position" ? simulateImpl(opts.body) : levers;
    throw new Error(`unexpected ${url}`);
  });
});
const sellCalls = () => apiFetch.mock.calls.filter(([url, o]) => url === "/api/simulate" && o?.body?.type === "sell_position");

describe("Decision Simulator — tabs", () => {
  it("opens on the business tab and only talks to the portfolio once its tab is opened", async () => {
    wrap(<DecisionSimulator sourceInfo={{ type: "excel", name: "x.xlsx" }} filters={{}} />);
    expect(screen.getByRole("tab", { name: "Negócio" })).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/simulate", expect.objectContaining({ body: expect.objectContaining({ type: "levers" }) })));
    expect(apiFetch).not.toHaveBeenCalledWith("/api/portfolio/analytics");

    await userEvent.click(screen.getByRole("tab", { name: "Carteira de ações" }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/portfolio/analytics"));
  });

  it("opens straight on the portfolio tab when there is no sales data", async () => {
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    expect(screen.getByRole("tab", { name: "Carteira de ações" })).toHaveAttribute("aria-selected", "true");
    await screen.findByText("Cenário");
    expect(apiFetch).not.toHaveBeenCalledWith("/api/simulate", expect.objectContaining({ body: expect.objectContaining({ type: "levers" }) }));
  });
});

describe("Decision Simulator — sell part of a position", () => {
  it("simulates the largest priced position at 25% by default and shows before/after for HHI, VaR and weights", async () => {
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    await screen.findByText("Concentração (HHI)");
    await waitFor(() => expect(sellCalls()).toHaveLength(1));
    expect(sellCalls()[0][1].body).toEqual({ type: "sell_position", ticker: "AAA", percent: 25 }); // AAA = 60%, the largest

    expect(await screen.findByText("0,460")).toBeInTheDocument();  // HHI before
    expect(screen.getByText("0,412")).toBeInTheDocument();          // HHI after
    expect(screen.getByText("VaR histórico 95% (1 dia)")).toBeInTheDocument();
    expect(screen.getByText("6,00%")).toBeInTheDocument();          // VaR before
    expect(screen.getByText("5,29%")).toBeInTheDocument();          // VaR after
    expect(screen.getByText(/Pesos antes e depois/)).toBeInTheDocument();
    expect(screen.getByText("52,94%")).toBeInTheDocument();
    // unpriced positions can't be picked: they have no weight
    expect(screen.queryByRole("option", { name: /NOP/ })).toBeNull();
  });

  it("re-runs the scenario when the position or the percentage changes", async () => {
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    await waitFor(() => expect(sellCalls()).toHaveLength(1));

    await userEvent.selectOptions(screen.getByLabelText("Posição"), "BBB");
    await waitFor(() => expect(sellCalls().at(-1)[1].body).toEqual({ type: "sell_position", ticker: "BBB", percent: 25 }));

    fireEvent.change(screen.getByLabelText("Parte da posição vendida"), { target: { value: "50" } });
    await waitFor(() => expect(sellCalls().at(-1)[1].body).toEqual({ type: "sell_position", ticker: "BBB", percent: 50 }));
  });

  it("does not colour the changes as good or bad, and always shows the not-financial-advice notice", async () => {
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Não constitui aconselhamento financeiro nem recomenda comprar ou vender.");
    await screen.findByText("-0,048"); // HHI delta rendered as a plain signed number
    expect(screen.getByText("-0,048").closest("span")).toHaveStyle({ color: "var(--text-secondary)" });
  });

  it("says 'dados insuficientes' for VaR (never a number) and shows why", async () => {
    simulateImpl = () => simulation({
      current: { ...simulation().current, var95: var95(null, null) },
      scenario: { ...simulation().scenario, var95: var95(null, null) },
      impact: { ...simulation().impact, var95DeltaPP: null, var95AmountDelta: null },
      warnings: [{ code: "var_insufficient_data", observations: 12, minObservations: 60 }],
    });
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    expect((await screen.findAllByText("Dados insuficientes")).length).toBe(2); // before and after
    expect(screen.getByText("Mínimo de 60 observações para calcular esta métrica — 12 disponíveis.")).toBeInTheDocument();
  });

  it("shows the engine's warnings in the person's language", async () => {
    simulateImpl = () => simulation({ warnings: [
      { code: "positions_outside", tickers: ["NOP"] },
      { code: "var_partial_coverage", coveredWeightPct: 90, tickers: ["CCC"] },
      { code: "fx_not_modelled", tickers: ["USD1"] },
    ] });
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    expect(await screen.findByText(/1 posições sem preço ou sem taxa de câmbio ficam fora do cálculo: NOP\./)).toBeInTheDocument();
    expect(screen.getByText(/O VaR cobre 90,0% do valor da carteira.*CCC\./)).toBeInTheDocument();
    expect(screen.getByText(/Os retornos de USD1 estão na moeda de origem.*EUR não está modelado\./)).toBeInTheDocument();
  });

  it("shows an error, not a stale result, when the simulation fails", async () => {
    simulateImpl = () => { throw new Error("boom"); };
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    expect(await screen.findByText("Não foi possível simular este cenário.")).toBeInTheDocument();
    expect(screen.queryByText("Pesos antes e depois")).toBeNull();
  });
});

describe("Decision Simulator — portfolio tab empty/failed states", () => {
  it("no positions at all", async () => {
    apiFetch.mockImplementation(async (url) => (url === "/api/portfolio/analytics" ? { defaultCurrency: "EUR", positions: [] } : levers));
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    expect(await screen.findByText("Ainda não há posições")).toBeInTheDocument();
    expect(sellCalls()).toHaveLength(0);
  });

  it("positions but none can be sized (no prices)", async () => {
    apiFetch.mockImplementation(async (url) => (url === "/api/portfolio/analytics" ? { defaultCurrency: "EUR", positions: [position("NOP", null, { semPreco: true })] } : levers));
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    expect(await screen.findByText(/Nenhuma posição tem preço e taxa de câmbio/)).toBeInTheDocument();
  });

  it("the positions failing to load", async () => {
    apiFetch.mockImplementation(async (url) => { if (url === "/api/portfolio/analytics") throw new Error("down"); return levers; });
    wrap(<DecisionSimulator sourceInfo={null} filters={{}} businessDataMissing />);
    expect(await screen.findByText("Não foi possível carregar as posições da carteira.")).toBeInTheDocument();
  });
});
