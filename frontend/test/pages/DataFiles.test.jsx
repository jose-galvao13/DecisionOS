import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ThemeModeProvider } from "../../src/lib/theme";
import { LangProvider } from "../../src/lib/i18n";
import { ToastProvider } from "../../src/components/ui";
import { computeAnalytics } from "../../src/lib/metrics";
import { generateDemoTransactions } from "../../src/lib/demoData";

vi.mock("../../src/api/client", () => ({
  apiFetch: vi.fn(),
  apiUpload: vi.fn(),
  pollJob: vi.fn(),
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
}));
import { apiFetch } from "../../src/api/client";
import DataPage from "../../src/pages/DataSources/DataPage";
import DecisionOSApp from "../../src/app/DecisionOSApp";

const wrap = (ui) =>
  render(
    <ThemeModeProvider>
      <LangProvider>
        <ToastProvider>{ui}</ToastProvider>
      </LangProvider>
    </ThemeModeProvider>
  );

const src = (over) => ({ id: "x", name: "x.xlsx", type: "excel", status: "connected", row_count: 10, last_sync_at: "2026-01-05T10:00:00Z", ...over });

describe("DataPage — several files", () => {
  const sources = [
    src({ id: "b", name: "vendas-2025.xlsx", row_count: 958 }),
    src({ id: "a", name: "vendas-2024.xlsx", row_count: 120 }),
    src({ id: "e", name: "partido.xlsx", status: "error", row_count: 0 }),
    src({ id: "s", name: "a-importar.xlsx", status: "syncing", row_count: 0 }),
  ];
  const props = (over = {}) => ({
    analytics: null, sourceInfo: { type: "excel", name: "vendas-2025.xlsx", rows: 958, dataSourceId: "b" },
    quality: null, onAdd: vi.fn(), replaceJob: null, sources, activeId: "b", onActivate: vi.fn(), onRemove: vi.fn(), busyId: null, canManage: true, ...over,
  });

  it("lists every file, marks the active one, and offers 'use this file' only where it makes sense", () => {
    wrap(<DataPage {...props()} />);
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(4);

    const [active, other, failed, importing] = rows;
    expect(within(active).getByText("vendas-2025.xlsx")).toBeInTheDocument();
    expect(within(active).getByText("Ativo")).toBeInTheDocument();
    expect(within(active).queryByText("Usar este ficheiro")).not.toBeInTheDocument(); // already in use

    expect(within(other).getByText("Usar este ficheiro")).toBeInTheDocument();
    expect(within(other).queryByText("Ativo")).not.toBeInTheDocument();

    // a failed or still-importing file can't be chosen, but can be removed
    expect(within(failed).getByText("A importação falhou")).toBeInTheDocument();
    expect(within(failed).queryByText("Usar este ficheiro")).not.toBeInTheDocument();
    expect(within(importing).getByText("A importar…")).toBeInTheDocument();
    expect(within(importing).queryByText("Usar este ficheiro")).not.toBeInTheDocument();
    expect(within(failed).getByRole("button", { name: /Remover partido\.xlsx/ })).toBeInTheDocument();
  });

  it("calls back with the right file for use / remove / add", () => {
    const p = props();
    wrap(<DataPage {...p} />);
    fireEvent.click(screen.getByText("Usar este ficheiro"));
    expect(p.onActivate).toHaveBeenCalledWith(sources[1]);

    fireEvent.click(screen.getByRole("button", { name: "Remover vendas-2024.xlsx" }));
    expect(p.onRemove).toHaveBeenCalledWith(sources[1]);

    fireEvent.click(screen.getByRole("button", { name: /Adicionar ficheiro/ }));
    expect(p.onAdd).toHaveBeenCalledTimes(1);
  });

  it("hides every action from people who can't manage data (viewers)", () => {
    wrap(<DataPage {...props({ canManage: false })} />);
    expect(screen.queryByText("Usar este ficheiro")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Adicionar ficheiro/ })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("source-row")).toHaveLength(4); // still sees the list
  });

  it("still shows the file in use when the list couldn't be loaded", () => {
    wrap(<DataPage {...props({ sources: [] })} />);
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("vendas-2025.xlsx")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Ativo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument(); // no list -> no actions on a guess
  });

  it("in demo mode shows the demo card and the add button", () => {
    wrap(<DataPage {...props({ sources: [], sourceInfo: { type: "demo", name: "", rows: 958 } })} />);
    expect(screen.getByText("Dados de demonstração sintéticos")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Adicionar ficheiro/ })).toBeInTheDocument();
  });

  it("disables the add button while an import is running", () => {
    wrap(<DataPage {...props({ replaceJob: { progress: 40, stage: "importing" } })} />);
    expect(screen.getByRole("button", { name: /Adicionar ficheiro/ })).toBeDisabled();
  });
});

describe("switching files inside the app", () => {
  const analyticsPayload = JSON.parse(JSON.stringify(computeAnalytics(generateDemoTransactions(), "pt-PT")));
  let sources; // server-side truth
  let active;
  let calls;

  beforeEach(() => {
    sources = [
      src({ id: "b", name: "vendas-2025.xlsx", row_count: 958, created_at: "2026-02-01" }),
      src({ id: "a", name: "vendas-2024.xlsx", row_count: 120, created_at: "2026-01-01" }),
    ];
    active = "b";
    calls = [];
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path, opts = {}) => {
      calls.push(`${opts.method || "GET"} ${path.split("?")[0]}`);
      if (path === "/api/datasources") return { dataSources: sources.map((s) => ({ ...s, is_active: s.id === active })) };
      if (path.endsWith("/activate")) { active = path.split("/")[3]; return { dataSourceId: active, active: true }; }
      if (path.endsWith("/quality")) return { score: 92, issues: [] };
      if (opts.method === "DELETE") {
        const id = path.split("/")[3];
        sources = sources.filter((s) => s.id !== id);
        if (active === id) active = sources[0]?.id ?? null;
        return { deleted: true, activeDataSourceId: active };
      }
      if (path.startsWith("/api/analytics/full")) return analyticsPayload;
      if (path.startsWith("/api/decisions")) return { decisions: [] };
      throw new Error(`unexpected request ${path}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  const openApp = async (role = "owner") => {
    wrap(<DecisionOSApp user={{ name: "Maria", orgName: "Acme Lda", role }} onLogout={() => {}} />);
    await screen.findByText("vendas-2025.xlsx"); // header shows the active file
    fireEvent.click(screen.getByRole("button", { name: "Dados" }));
    await screen.findAllByTestId("source-row");
  };
  const analyticsCalls = () => calls.filter((c) => c === "GET /api/analytics/full").length;

  it("starts on the file the server says is active and shows both files on the Data page", async () => {
    await openApp();
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Ativo")).toBeInTheDocument();
    expect(within(rows[1]).getByText("vendas-2024.xlsx")).toBeInTheDocument();
  });

  it("'Usar este ficheiro' activates it on the server, swaps the active file and asks for fresh analytics", async () => {
    await openApp();
    const before = analyticsCalls();

    fireEvent.click(screen.getByText("Usar este ficheiro"));

    await waitFor(() => expect(calls).toContain("POST /api/datasources/a/activate"));
    await waitFor(() => {
      const rows = screen.getAllByTestId("source-row");
      expect(within(rows[1]).getByText("Ativo")).toBeInTheDocument(); // vendas-2024 is now the active one
      expect(within(rows[0]).queryByText("Ativo")).not.toBeInTheDocument();
    });
    // the header pill follows the active file
    expect(screen.getAllByText("vendas-2024.xlsx").length).toBeGreaterThan(1);
    // and the dashboards were recomputed for it (not served from the previous file's state)
    await waitFor(() => expect(analyticsCalls()).toBeGreaterThan(before));
    expect(calls).toContain("GET /api/datasources/a/quality");
  });

  it("removing the active file moves to the next one; removing the last one goes back to upload", async () => {
    await openApp();

    fireEvent.click(screen.getByRole("button", { name: "Remover vendas-2025.xlsx" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/datasources/b"));
    await waitFor(() => expect(screen.getAllByTestId("source-row")).toHaveLength(1));
    const remaining = screen.getByTestId("source-row");
    expect(within(remaining).getByText("vendas-2024.xlsx")).toBeInTheDocument();
    expect(within(remaining).getByText("Ativo")).toBeInTheDocument(); // fell back to it

    fireEvent.click(screen.getByRole("button", { name: "Remover vendas-2024.xlsx" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/datasources/a"));
    // nothing left: the onboarding/upload modal is offered again
    await waitFor(() => expect(screen.queryAllByTestId("source-row")).toHaveLength(0));
  });

  it("does nothing when the person cancels the confirmation", async () => {
    window.confirm.mockReturnValue(false);
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Remover vendas-2024.xlsx" }));
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(screen.getAllByTestId("source-row")).toHaveLength(2);
  });

  it("gives viewers the list but no way to change it", async () => {
    await openApp("viewer");
    expect(screen.queryByText("Usar este ficheiro")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remover/ })).not.toBeInTheDocument();
  });
});
