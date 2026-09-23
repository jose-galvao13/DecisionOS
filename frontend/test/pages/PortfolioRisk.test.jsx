import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
import PortfolioPage from "../../src/pages/Portfolio/PortfolioPage";

const wrap = (ui) =>
  render(
    <ThemeModeProvider>
      <LangProvider>
        <ToastProvider>{ui}</ToastProvider>
      </LangProvider>
    </ThemeModeProvider>
  );

const holdingsResponse = { holdings: [], totals: { custoTotal: 0, valorAtual: 0 } };
const analyticsResponse = null;

const riskResponse = {
  minObservations: 60,
  indexTicker: null,
  tickers: ["AAA", "BBB"],
  perTicker: {
    AAA: {
      ticker: "AAA", observations: 65, insufficientData: false,
      volatilidadeAnualizada: 0.32, maxDrawdownPct: -18.5, var95Pct: 2.1,
      beta: null, betaInsufficientData: null,
      drawdownCurve: [{ data: "2024-01-01", drawdownPct: 0 }, { data: "2024-01-02", drawdownPct: -5 }],
    },
    BBB: {
      ticker: "BBB", observations: 12, insufficientData: true,
      volatilidadeAnualizada: null, maxDrawdownPct: -3.2, var95Pct: null,
      beta: null, betaInsufficientData: null,
      drawdownCurve: [{ data: "2024-01-01", drawdownPct: 0 }],
    },
  },
  correlationMatrix: { AAA: { AAA: 1, BBB: 0.42 }, BBB: { AAA: 0.42, BBB: 1 } },
};

describe("PortfolioPage — FASE 3 Risco tab", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockImplementation((path) => {
      if (path === "/api/portfolio/holdings") return Promise.resolve(holdingsResponse);
      if (path === "/api/portfolio/analytics") return Promise.resolve(analyticsResponse);
      if (path.startsWith("/api/portfolio/risk")) return Promise.resolve(riskResponse);
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
  });

  it("does not call GET /api/portfolio/risk until the Risco tab is opened", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/portfolio/holdings"));
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/portfolio/risk"));
  });

  it("loads and renders per-ticker risk metrics once the Risco tab is opened", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await waitFor(() => expect(screen.getByText("Risco")).toBeTruthy());
    await userEvent.click(screen.getByText("Risco"));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/portfolio/risk"));
    await waitFor(() => expect(screen.getAllByText("AAA").length).toBeGreaterThan(0));
    expect(screen.getAllByText("BBB").length).toBeGreaterThan(0);
    // insufficient-data pill for BBB (12 observations < 60)
    expect(screen.getByText("Dados insuficientes")).toBeTruthy();
  });

  it("shows an empty state when there is no price history yet", async () => {
    apiFetch.mockImplementation((path) => {
      if (path === "/api/portfolio/holdings") return Promise.resolve(holdingsResponse);
      if (path === "/api/portfolio/analytics") return Promise.resolve(analyticsResponse);
      if (path.startsWith("/api/portfolio/risk")) return Promise.resolve({ minObservations: 60, tickers: [], perTicker: {}, correlationMatrix: {} });
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await userEvent.click(await screen.findByText("Risco"));
    await waitFor(() => expect(screen.getByText("Ainda não há histórico de preços")).toBeTruthy());
  });

  it("a manager sees the upload and 'fetch via API' actions; a viewer does not", async () => {
    wrap(<PortfolioPage user={{ role: "manager" }} />);
    await userEvent.click(await screen.findByText("Risco"));
    await waitFor(() => expect(screen.getByText("Importar histórico de preços (Excel/CSV)")).toBeTruthy());
    expect(screen.getByText("Tentar obter via API")).toBeTruthy();
  });

  it("hides upload/API actions for a viewer", async () => {
    wrap(<PortfolioPage user={{ role: "viewer" }} />);
    await userEvent.click(await screen.findByText("Risco"));
    await waitFor(() => expect(screen.getAllByText("AAA").length).toBeGreaterThan(0));
    expect(screen.queryByText("Importar histórico de preços (Excel/CSV)")).toBeNull();
    expect(screen.queryByText("Tentar obter via API")).toBeNull();
  });
});
