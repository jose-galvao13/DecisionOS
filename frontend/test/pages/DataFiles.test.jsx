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
  apiDownload: vi.fn(),
  saveBlob: vi.fn(),
  pollJob: vi.fn(),
  getToken: vi.fn(() => null),
  setToken: vi.fn(),
}));
import { apiFetch, apiDownload, saveBlob } from "../../src/api/client";
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

// Actions other than "Use this file" live in the "⋯" menu of each row.
const openMenu = (fileName) => fireEvent.click(screen.getByRole("button", { name: `Mais opções de ${fileName}` }));
const chooseFromMenu = (fileName, item) => { openMenu(fileName); fireEvent.click(screen.getByRole("menuitem", { name: item })); };

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
    expect(within(failed).getByRole("button", { name: "Mais opções de partido.xlsx" })).toBeInTheDocument();
  });

  it("calls back with the right file for use / remove / add", () => {
    const p = props();
    wrap(<DataPage {...p} />);
    fireEvent.click(screen.getByText("Usar este ficheiro"));
    expect(p.onActivate).toHaveBeenCalledWith(sources[1]);

    chooseFromMenu("vendas-2024.xlsx", "Remover");
    expect(p.onRemove).toHaveBeenCalledWith(sources[1]);

    fireEvent.click(screen.getByRole("button", { name: /Adicionar ficheiro/ }));
    expect(p.onAdd).toHaveBeenCalledTimes(1);
  });

  it("hides every action from people who can't manage data (viewers)", () => {
    wrap(<DataPage {...props({ canManage: false })} />);
    expect(screen.queryByText("Usar este ficheiro")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Adicionar ficheiro/ })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("source-row")).toHaveLength(4); // still sees the list
    // ...and can look at a file's details, but the menu offers nothing that changes or exports data
    openMenu("vendas-2024.xlsx");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Ver detalhes"]);
  });

  it("still shows the file in use when the list couldn't be loaded", () => {
    wrap(<DataPage {...props({ sources: [] })} />);
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("vendas-2025.xlsx")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Ativo")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mais opções/ })).not.toBeInTheDocument(); // no list -> no actions on a guess
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

describe("DataPage — the ⋯ menu of each file", () => {
  const sources = [
    src({ id: "b", name: "vendas-2025.xlsx", row_count: 958 }),
    src({ id: "a", name: "vendas-2024.xlsx", row_count: 120 }),
    src({ id: "e", name: "partido.xlsx", status: "error", row_count: 0 }),
  ];
  const props = (over = {}) => ({
    analytics: null, sourceInfo: { type: "excel", name: "vendas-2025.xlsx", rows: 958, dataSourceId: "b" },
    quality: null, onAdd: vi.fn(), replaceJob: null, sources, activeId: "b",
    onActivate: vi.fn(), onRemove: vi.fn(), onRename: vi.fn(async () => true), onExport: vi.fn(), busyId: null, exportingId: null, canManage: true, ...over,
  });
  const items = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

  it("offers rename, details, export and remove — and no export for a file that has no imported data", () => {
    wrap(<DataPage {...props()} />);
    openMenu("vendas-2024.xlsx");
    expect(items()).toEqual(["Renomear", "Ver detalhes", "Exportar para Excel", "Remover"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    openMenu("partido.xlsx");
    expect(items()).toEqual(["Renomear", "Ver detalhes", "Remover"]);
  });

  it("closes on Escape and on a click outside, and hands focus back to the button", () => {
    wrap(<DataPage {...props()} />);
    openMenu("vendas-2024.xlsx");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mais opções de vendas-2024.xlsx" })).toHaveFocus();

    openMenu("vendas-2024.xlsx");
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renames in place: Enter saves the trimmed name, Escape cancels", async () => {
    const p = props();
    wrap(<DataPage {...p} />);

    chooseFromMenu("vendas-2024.xlsx", "Renomear");
    let input = screen.getByRole("textbox", { name: "Novo nome do ficheiro" });
    expect(input).toHaveValue("vendas-2024.xlsx");
    fireEvent.change(input, { target: { value: "  Vendas 2024 finais  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(p.onRename).toHaveBeenCalledWith(sources[1], "Vendas 2024 finais"));
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());

    chooseFromMenu("vendas-2024.xlsx", "Renomear");
    input = screen.getByRole("textbox", { name: "Novo nome do ficheiro" });
    fireEvent.change(input, { target: { value: "outro" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(p.onRename).toHaveBeenCalledTimes(1);
  });

  it("doesn't save an empty or unchanged name, and stays in edit mode if the server refuses", async () => {
    const p = props({ onRename: vi.fn(async () => false) });
    wrap(<DataPage {...p} />);
    chooseFromMenu("vendas-2024.xlsx", "Renomear");
    const input = screen.getByRole("textbox", { name: "Novo nome do ficheiro" });

    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Guardar" })).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(p.onRename).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "novo.xlsx" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(p.onRename).toHaveBeenCalledWith(sources[1], "novo.xlsx"));
    expect(screen.getByRole("textbox", { name: "Novo nome do ficheiro" })).toBeInTheDocument(); // still editing: the person can fix it
  });

  it("hands the right file to export", () => {
    const p = props();
    wrap(<DataPage {...p} />);
    chooseFromMenu("vendas-2024.xlsx", "Exportar para Excel");
    expect(p.onExport).toHaveBeenCalledWith(sources[1]);
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
      if (path.endsWith("/quality")) return { score: "92.0", issues: [{ severity: "green", code: "valid_revenue_pct", count: 10, message: "92.0% das receitas válidas" }], stats: { rows: 10, missingPct: 1.5, duplicates: 2, invalidIds: 0, inconsistent: 0 } };
      if (opts.method === "DELETE") {
        const id = path.split("/")[3];
        sources = sources.filter((s) => s.id !== id);
        if (active === id) active = sources[0]?.id ?? null;
        return { deleted: true, activeDataSourceId: active };
      }
      if (opts.method === "PATCH") {
        const target = sources.find((x) => x.id === path.split("/")[3]);
        target.name = opts.body.name;
        return { id: target.id, name: target.name };
      }
      if (/^\/api\/datasources\/[^/]+$/.test(path)) {
        const target = sources.find((x) => x.id === path.split("/")[3]);
        return {
          id: target.id, name: target.name, type: "excel", status: "connected", rowCount: target.row_count,
          createdAt: "2026-01-01T10:00:00Z", lastSyncAt: target.last_sync_at, createdByName: "Maria",
          columnMapping: { date: "Dia da venda", revenue: "Valor líquido", customer: "Nome cliente" }, dateRange: { from: "2024-01-01", to: "2024-12-31" },
        };
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

    chooseFromMenu("vendas-2025.xlsx", "Remover");
    await waitFor(() => expect(calls).toContain("DELETE /api/datasources/b"));
    await waitFor(() => expect(screen.getAllByTestId("source-row")).toHaveLength(1));
    const remaining = screen.getByTestId("source-row");
    expect(within(remaining).getByText("vendas-2024.xlsx")).toBeInTheDocument();
    expect(within(remaining).getByText("Ativo")).toBeInTheDocument(); // fell back to it

    chooseFromMenu("vendas-2024.xlsx", "Remover");
    await waitFor(() => expect(calls).toContain("DELETE /api/datasources/a"));
    // nothing left: the onboarding/upload modal is offered again
    await waitFor(() => expect(screen.queryAllByTestId("source-row")).toHaveLength(0));
  });

  it("does nothing when the person cancels the confirmation", async () => {
    window.confirm.mockReturnValue(false);
    await openApp();
    chooseFromMenu("vendas-2024.xlsx", "Remover");
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(screen.getAllByTestId("source-row")).toHaveLength(2);
  });

  it("gives viewers the list but no way to change it", async () => {
    await openApp("viewer");
    expect(screen.queryByText("Usar este ficheiro")).not.toBeInTheDocument();
    openMenu("vendas-2024.xlsx");
    expect(screen.queryByRole("menuitem", { name: /Remover|Renomear|Exportar/ })).not.toBeInTheDocument();
  });
  it("renames a file on the server and everywhere it is shown (list + header pill of the active file)", async () => {
    await openApp();
    chooseFromMenu("vendas-2025.xlsx", "Renomear"); // the active one
    const input = screen.getByRole("textbox", { name: "Novo nome do ficheiro" });
    fireEvent.change(input, { target: { value: "Vendas oficiais" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(calls).toContain("PATCH /api/datasources/b"));
    expect(apiFetch).toHaveBeenCalledWith("/api/datasources/b", { method: "PATCH", body: { name: "Vendas oficiais" } });
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
    expect(within(screen.getAllByTestId("source-row")[0]).getByText("Vendas oficiais")).toBeInTheDocument();
    expect(screen.getAllByText("Vendas oficiais").length).toBeGreaterThan(1); // header pill follows
    expect(screen.queryByText("vendas-2025.xlsx")).not.toBeInTheDocument();
  });

  it("shows the file's error and keeps the field open when the rename is refused", async () => {
    await openApp();
    apiFetch.mockImplementationOnce(async () => { throw new Error("name is required"); });
    chooseFromMenu("vendas-2024.xlsx", "Renomear");
    const input = screen.getByRole("textbox", { name: "Novo nome do ficheiro" });
    fireEvent.change(input, { target: { value: "x" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("name is required")).toBeInTheDocument(); // toast
    expect(screen.getByRole("textbox", { name: "Novo nome do ficheiro" })).toBeInTheDocument();
  });

  it("exports a file to .xlsx through an authenticated download", async () => {
    const blob = new Blob(["xlsx-bytes"]);
    apiDownload.mockResolvedValueOnce(blob);
    await openApp();
    chooseFromMenu("vendas-2024.xlsx", "Exportar para Excel");
    await waitFor(() => expect(apiDownload).toHaveBeenCalledWith("/api/datasources/a/export"));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(blob, "vendas-2024_export.xlsx"));
    expect(await screen.findByText(/"vendas-2024\.xlsx" exportado\./)).toBeInTheDocument();
  });

  it("tells the person when the export fails", async () => {
    apiDownload.mockRejectedValueOnce(new Error("requires role 'manager' or higher"));
    await openApp();
    chooseFromMenu("vendas-2024.xlsx", "Exportar para Excel");
    expect(await screen.findByText("requires role 'manager' or higher")).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("opens the details of a file that is NOT the active one: period, mapping and its own quality report", async () => {
    await openApp();
    chooseFromMenu("vendas-2024.xlsx", "Ver detalhes");
    const dialog = await screen.findByRole("dialog", { name: "vendas-2024.xlsx" });
    await within(dialog).findByText("Colunas mapeadas");
    expect(within(dialog).getByText(/01\/01\/2024 – 31\/12\/2024/)).toBeInTheDocument();
    // field label (translated) -> the column of the file it was mapped to
    expect(within(dialog).getByText("Receita")).toBeInTheDocument();
    expect(within(dialog).getByText("Valor líquido")).toBeInTheDocument();
    expect(within(dialog).getByText("Dia da venda")).toBeInTheDocument();
    expect(within(dialog).getByText("Maria")).toBeInTheDocument();
    // its quality report: a string score from Postgres still renders as a number, and the issue is translated
    expect(await within(dialog).findByText("92% saudável")).toBeInTheDocument();
    expect(within(dialog).getByText("92,0% das receitas são válidas")).toBeInTheDocument();
    expect(calls).toContain("GET /api/datasources/a");
    expect(calls).toContain("GET /api/datasources/a/quality");
    expect(calls).not.toContain("POST /api/datasources/a/activate"); // looking is not switching

    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
