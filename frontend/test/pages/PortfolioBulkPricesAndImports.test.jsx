import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
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
import { apiFetch, apiUpload } from "../../src/api/client";
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


// Bulk pricing + import removal on the Carteira page (Parte 2, FASE 4 follow-up).
const imports = { imports: [{ id: "imp-1", name: "carteira_teste.xlsx", status: "connected", row_count: 10, created_at: "2026-09-24T08:00:00Z" }] };

describe("PortfolioPage — bulk price upload and import removal", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiUpload.mockReset();
    apiFetch.mockImplementation((path, opts) => {
      if (path === "/api/portfolio/holdings") return Promise.resolve(holdingsResponse);
      if (path === "/api/portfolio/analytics") return Promise.resolve(analyticsResponse);
      if (path === "/api/portfolio/imports") return Promise.resolve(imports);
      if (path === "/api/portfolio/imp-1" && opts?.method === "DELETE") return Promise.resolve({ deleted: true });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  it("uploads a prices file to /prices/upload, then refreshes holdings and analytics", async () => {
    apiUpload.mockResolvedValue({ imported: 9, skipped: 0, issues: [], notHeld: [] });
    wrap(<PortfolioPage user={{ role: "manager" }} />);
    const input = await screen.findByLabelText("Carregar preços (Excel/CSV)");
    const file = new File(["x"], "precos.xlsx");
    const before = apiFetch.mock.calls.filter(([p]) => p === "/api/portfolio/analytics").length;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(apiUpload).toHaveBeenCalledTimes(1));
    expect(apiUpload.mock.calls[0][0]).toBe("/api/portfolio/prices/upload");
    expect(apiUpload.mock.calls[0][1].get("file")).toBe(file);
    expect(await screen.findByText("9 preços guardados.")).toBeInTheDocument();
    await waitFor(() => expect(apiFetch.mock.calls.filter(([p]) => p === "/api/portfolio/analytics").length).toBe(before + 1));
  });

  it("says how many rows were skipped and which one was first", async () => {
    apiUpload.mockResolvedValue({ imported: 8, skipped: 2, issues: [{ row: 5, reason: "invalid_price" }], notHeld: ["ZZZ"] });
    wrap(<PortfolioPage user={{ role: "manager" }} />);
    fireEvent.change(await screen.findByLabelText("Carregar preços (Excel/CSV)"), { target: { files: [new File(["x"], "p.xlsx")] } });
    expect(await screen.findByText("2 linhas ignoradas — a primeira: linha 5 (preço inválido).")).toBeInTheDocument();
    expect(await screen.findByText("1 tickers do ficheiro não estão na carteira: ZZZ.")).toBeInTheDocument();
  });

  it("is only offered to people who can manage the portfolio", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/portfolio/holdings"));
    expect(screen.queryByLabelText("Carregar preços (Excel/CSV)")).toBeNull();
  });

  it("lists the imports and removes one after confirming", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    wrap(<PortfolioPage user={{ role: "manager" }} />);
    const btn = await screen.findByRole("button", { name: /Remover carteira_teste\.xlsx/ });
    fireEvent.click(btn);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/portfolio/imp-1", { method: "DELETE" }));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("does nothing when the confirmation is refused", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    wrap(<PortfolioPage user={{ role: "manager" }} />);
    fireEvent.click(await screen.findByRole("button", { name: /Remover carteira_teste\.xlsx/ }));
    expect(apiFetch).not.toHaveBeenCalledWith("/api/portfolio/imp-1", expect.anything());
    confirm.mockRestore();
  });
});
