import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
import PortfolioPage from "../../src/pages/Portfolio/PortfolioPage";

const wrap = (ui) =>
  render(
    <ThemeModeProvider>
      <LangProvider>
        <ToastProvider>{ui}</ToastProvider>
      </LangProvider>
    </ThemeModeProvider>
  );

const holdingsResponse = {
  holdings: [
    { ticker: "AAA", nome: "Acme", sector: "Tech", pais: "US", quantidade: 10, precoMedio: 10, moeda: "EUR", custoTotal: 100, precoAtual: 15, valorAtual: 150, ganhoPerdaAbs: 50, ganhoPerdaPct: 50, fileCount: 1 },
    { ticker: "DDD", nome: "Delta", sector: null, pais: null, quantidade: 10, precoMedio: 10, moeda: "EUR", custoTotal: 100, precoAtual: null, valorAtual: null, ganhoPerdaAbs: null, ganhoPerdaPct: null, fileCount: 1 },
  ],
  totals: { custoTotal: 200, valorAtual: 250 },
};

const analyticsResponse = {
  defaultCurrency: "EUR",
  positions: [
    { ticker: "AAA", nome: "Acme", sector: "Tech", pais: "US", moeda: "EUR", quantidade: 10, precoMedio: 10, precoAtual: 15, custoTotal: 100, valorAtual: 150, valorAtualConvertido: 150, pnlNaoRealizado: 50, pesoPct: 100, semPreco: false, semTaxaCambio: false },
    { ticker: "DDD", nome: "Delta", sector: "N/D", pais: "N/D", moeda: "EUR", quantidade: 10, precoMedio: 10, precoAtual: null, custoTotal: 100, valorAtual: null, valorAtualConvertido: null, pnlNaoRealizado: null, pesoPct: null, semPreco: true, semTaxaCambio: false },
  ],
  totals: {
    valorAtual: 150, custoTotalComPreco: 100, custoTotalSemPreco: 100,
    pnlNaoRealizado: 50, pnlNaoRealizadoPct: 50,
    posicoes: 2, posicoesComPreco: 1, posicoesSemPreco: 1,
  },
  concentration: { hhi: 1, effectiveN: 1, top3: [{ ticker: "AAA", nome: "Acme", pesoPct: 100 }], top3Pct: 100 },
  exposures: {
    byCurrency: [{ key: "EUR", pesoPct: 100 }],
    bySector: [{ key: "Tech", pesoPct: 100 }],
    byCountry: [{ key: "US", pesoPct: 100 }],
  },
  warnings: [
    { code: "sem_preco", message: "1 posições sem preço", tickers: ["DDD"] },
    { code: "sector_nd", message: "1 posições sem sector", count: 1 },
    { code: "pais_nd", message: "1 posições sem país", count: 1 },
  ],
};

describe("PortfolioPage — FASE 2 analytics section", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation((path) => {
      if (path === "/api/portfolio/holdings") return Promise.resolve(holdingsResponse);
      if (path === "/api/portfolio/analytics") return Promise.resolve(analyticsResponse);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  it("loads both holdings and analytics on mount", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/portfolio/holdings"));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/portfolio/analytics"));
  });

  it("shows HHI, effective N and the top3 concentration", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(screen.getByText("Concentração (HHI)")).toBeTruthy());
    expect(screen.getByText("1.000")).toBeTruthy(); // HHI
    expect(screen.getByText("1.0")).toBeTruthy(); // effective N
    expect(screen.getByText(/AAA · 100.0%/)).toBeTruthy();
  });

  it("renders the visible warnings banner for missing-price and N/D data", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(screen.getByText("Avisos sobre os dados")).toBeTruthy());
    expect(screen.getByText(/posições sem preço atual/)).toBeTruthy();
    expect(screen.getByText(/posições sem setor \(N\/D\)/)).toBeTruthy();
    expect(screen.getByText(/posições sem país \(N\/D\)/)).toBeTruthy();
  });

  it("marks the unpriced position's row with a 'sem preço' pill and no weight", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(screen.getByText("DDD")).toBeTruthy());
    expect(screen.getAllByText("Sem cotação").length).toBeGreaterThan(0);
  });

  it("still renders the KPI cards and table if the analytics call fails", async () => {
    apiFetch.mockImplementation((path) => {
      if (path === "/api/portfolio/holdings") return Promise.resolve(holdingsResponse);
      if (path === "/api/portfolio/analytics") return Promise.reject(new Error("boom"));
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(screen.getByText("AAA")).toBeTruthy());
    // no analytics section (concentration HHI) when the analytics call failed
    expect(screen.queryByText("Concentração (HHI)")).toBeNull();
  });
});
