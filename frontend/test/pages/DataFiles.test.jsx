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
import { apiFetch, apiUpload, apiDownload, saveBlob, pollJob } from "../../src/api/client";
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

describe("DataPage — several files included in the analysis", () => {
  const sources = [
    src({ id: "b", name: "vendas-2025.xlsx", row_count: 958, quality_score: 92 }),
    src({ id: "a", name: "vendas-2024.xlsx", row_count: 120, quality_score: 65.4 }),
    src({ id: "e", name: "partido.xlsx", status: "error", row_count: 0 }),
    src({ id: "s", name: "a-importar.xlsx", status: "syncing", row_count: 0 }),
  ];
  const props = (over = {}) => ({
    analytics: null, sourceInfo: { type: "excel", name: "vendas-2025.xlsx", rows: 958, dataSourceId: "b" },
    quality: null, onAdd: vi.fn(), replaceJob: null, sources, activeIds: ["b"], onToggle: vi.fn(), onRemove: vi.fn(), busyId: null, canManage: true, ...over,
  });
  const switchOf = (row) => within(row).queryByRole("switch");

  it("lists every file with a switch to include it — only where a switch makes sense", () => {
    wrap(<DataPage {...props()} />);
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(4);

    const [included, other, failed, importing] = rows;
    expect(included).toHaveAttribute("data-included", "true");
    expect(switchOf(included)).toHaveAttribute("aria-checked", "true");
    expect(other).toHaveAttribute("data-included", "false");
    expect(switchOf(other)).toHaveAttribute("aria-checked", "false");
    expect(switchOf(other)).toBeEnabled();

    // a failed or still-importing file can't be included (there is nothing to include), but can be removed
    expect(within(failed).getByText("A importação falhou")).toBeInTheDocument();
    expect(switchOf(failed)).toBeNull();
    expect(within(importing).getByText("A importar…")).toBeInTheDocument();
    expect(switchOf(importing)).toBeNull();
    expect(within(failed).getByRole("button", { name: "Mais opções de partido.xlsx" })).toBeInTheDocument();
  });

  it("the switch is named after its file, so a screen reader hears which one it changes", () => {
    wrap(<DataPage {...props()} />);
    expect(screen.getByRole("switch", { name: 'Incluir "vendas-2024.xlsx" na análise' })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: 'Incluir "vendas-2025.xlsx" na análise' })).toBeInTheDocument();
  });

  it("the last included file can't be switched off — the switch is disabled and says why", () => {
    wrap(<DataPage {...props({ activeIds: ["b"] })} />);
    const sw = screen.getByRole("switch", { name: 'Incluir "vendas-2025.xlsx" na análise' });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("title", "Pelo menos um ficheiro tem de ficar incluído.");
  });

  it("with several included, any of them can be switched off, and the summary adds them up", () => {
    wrap(<DataPage {...props({ activeIds: ["b", "a"] })} />);
    const [b, a] = screen.getAllByTestId("source-row");
    expect(switchOf(b)).toHaveAttribute("aria-checked", "true");
    expect(switchOf(a)).toHaveAttribute("aria-checked", "true");
    expect(switchOf(b)).toBeEnabled();
    expect(switchOf(a)).toBeEnabled();
    // 2 of the 2 files that have data (the failed and the importing one don't count) · 958 + 120 rows
    expect(screen.getByTestId("included-summary")).toHaveTextContent(/2 de 2 ficheiros incluídos na análise · 1\D?078 linhas/);
  });

  it("the summary says how many of the usable files are included", () => {
    wrap(<DataPage {...props({ activeIds: ["b"] })} />);
    expect(screen.getByTestId("included-summary")).toHaveTextContent("1 de 2 ficheiros incluídos na análise · 958 linhas");
  });

  it("shows each file's own quality, and none for a file that has no report or no data", () => {
    wrap(<DataPage {...props()} />);
    const [b, a, e, s] = screen.getAllByTestId("source-row");
    expect(within(b).getByTestId("quality-chip")).toHaveTextContent("Qualidade 92%");
    expect(within(a).getByTestId("quality-chip")).toHaveTextContent("Qualidade 65%"); // 65.4, rounded
    expect(within(e).queryByTestId("quality-chip")).toBeNull();
    expect(within(s).queryByTestId("quality-chip")).toBeNull();
  });

  it("a file without a quality report yet simply has no chip (the score comes as null)", () => {
    wrap(<DataPage {...props({ sources: [src({ id: "n", name: "novo.xlsx", quality_score: null })], activeIds: ["n"] })} />);
    expect(screen.queryByTestId("quality-chip")).toBeNull();
  });

  it("calls back with the right file for include / remove / add", () => {
    const p = props();
    wrap(<DataPage {...p} />);
    fireEvent.click(screen.getByRole("switch", { name: 'Incluir "vendas-2024.xlsx" na análise' }));
    expect(p.onToggle).toHaveBeenCalledWith(sources[1]);

    chooseFromMenu("vendas-2024.xlsx", "Remover");
    expect(p.onRemove).toHaveBeenCalledWith(sources[1]);

    fireEvent.click(screen.getByRole("button", { name: /Adicionar ficheiro/ }));
    expect(p.onAdd).toHaveBeenCalledTimes(1);
  });

  it("switches off a file that is included together with another", () => {
    const p = props({ activeIds: ["b", "a"] });
    wrap(<DataPage {...p} />);
    fireEvent.click(screen.getByRole("switch", { name: 'Incluir "vendas-2025.xlsx" na análise' }));
    expect(p.onToggle).toHaveBeenCalledWith(sources[0]);
  });

  it("shows a busy file's switch as disabled while its change is in flight", () => {
    wrap(<DataPage {...props({ busyId: "a" })} />);
    expect(screen.getByRole("switch", { name: 'Incluir "vendas-2024.xlsx" na análise' })).toBeDisabled();
    expect(screen.getByRole("switch", { name: 'Incluir "vendas-2025.xlsx" na análise' })).toBeDisabled(); // last included anyway
  });

  it("hides every action from people who can't manage data (viewers), but still shows what is included", () => {
    wrap(<DataPage {...props({ canManage: false, activeIds: ["b", "a"] })} />);
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Adicionar ficheiro/ })).not.toBeInTheDocument();
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(4); // still sees the list
    expect(within(rows[0]).getByText("Incluído")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Incluído")).toBeInTheDocument();
    // ...and can look at a file's details, but the menu offers nothing that changes or exports data
    openMenu("vendas-2024.xlsx");
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Ver detalhes"]);
  });

  it("falls back to each file's own is_active flag when the shell doesn't pass the set", () => {
    wrap(<DataPage {...props({ activeIds: undefined, sources: [src({ id: "b", name: "vendas-2025.xlsx", is_active: true }), src({ id: "a", name: "vendas-2024.xlsx", is_active: false })] })} />);
    const [b, a] = screen.getAllByTestId("source-row");
    expect(b).toHaveAttribute("data-included", "true");
    expect(a).toHaveAttribute("data-included", "false");
  });

  it("still shows the file in use when the list couldn't be loaded", () => {
    wrap(<DataPage {...props({ sources: [] })} />);
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("vendas-2025.xlsx")).toBeInTheDocument();
    expect(rows[0]).toHaveAttribute("data-included", "true");
    expect(screen.queryByRole("button", { name: /Mais opções/ })).not.toBeInTheDocument(); // no list -> no actions on a guess
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByTestId("included-summary")).toBeNull();
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
    quality: null, onAdd: vi.fn(), replaceJob: null, sources, activeIds: ["b"],
    onToggle: vi.fn(), onRemove: vi.fn(), onRename: vi.fn(async () => true), onExport: vi.fn(), busyId: null, exportingId: null, canManage: true, ...over,
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

describe("including files in the analysis, inside the app", () => {
  const analyticsPayload = JSON.parse(JSON.stringify(computeAnalytics(generateDemoTransactions(), "pt-PT")));
  let sources; // server-side truth
  let included; // ids of the included files (the backend's is_active set)
  let duplicateOf; // id -> the files it repeats: including it asks for confirmation
  let calls;
  let notificationsPayload;

  const duplicateError = (overlaps) => Object.assign(new Error("this file overlaps with an already-active file and shares rows that look duplicated"), {
    status: 409, code: "possible_duplicates", data: { code: "possible_duplicates", overlaps },
  });

  beforeEach(() => {
    sources = [
      src({ id: "b", name: "vendas-2025.xlsx", row_count: 958, created_at: "2026-02-01", quality_score: 92 }),
      src({ id: "a", name: "vendas-2024.xlsx", row_count: 120, created_at: "2026-01-01", quality_score: 65 }),
    ];
    included = new Set(["b"]);
    duplicateOf = {};
    calls = [];
    notificationsPayload = { notifications: [], unreadCount: 0 };
    apiFetch.mockReset();
    apiFetch.mockImplementation(async (path, opts = {}) => {
      calls.push(`${opts.method || "GET"} ${path.split("?")[0]}`);
      if (path === "/api/datasources") return { dataSources: sources.map((s) => ({ ...s, is_active: included.has(s.id) })) };
      if (path.includes("/activate")) {
        const id = path.split("/")[3].split("?")[0];
        if (included.has(id)) {
          if (included.size <= 1) throw Object.assign(new Error("at least one data source must stay active — activate another one first"), { status: 409 });
          included.delete(id);
          return { dataSourceId: id, active: false, activeDataSourceIds: [...included] };
        }
        if (duplicateOf[id] && !path.includes("ignoreDuplicates=true")) throw duplicateError(duplicateOf[id]);
        included.add(id);
        return { dataSourceId: id, active: true, activeDataSourceIds: [...included] };
      }
      if (path.endsWith("/quality")) {
        const id = path.split("/")[3];
        const score = sources.find((x) => x.id === id)?.quality_score ?? 92;
        return { score: `${score}.0`, issues: [{ severity: "green", code: "valid_revenue_pct", count: 10, message: `${score}.0% das receitas válidas` }], stats: { rows: 10, missingPct: 1.5, duplicates: 2, invalidIds: 0, inconsistent: 0 } };
      }
      if (opts.method === "DELETE") {
        const id = path.split("/")[3];
        sources = sources.filter((s) => s.id !== id);
        included.delete(id);
        if (!included.size && sources.length) included.add(sources[0].id); // the backend falls back to the newest remaining file
        return { deleted: true, activeDataSourceId: [...included][0] ?? null, activeDataSourceIds: [...included] };
      }
      if (opts.method === "PATCH") {
        const target = sources.find((x) => x.id === path.split("/")[3]);
        target.name = opts.body.name;
        return { id: target.id, name: target.name };
      }
      if (path === "/api/datasources/excel/commit") return { jobId: "job-1", dataSourceId: "n" };
      if (/^\/api\/datasources\/[^/]+$/.test(path)) {
        const target = sources.find((x) => x.id === path.split("/")[3]);
        return {
          id: target.id, name: target.name, type: "excel", status: "connected", rowCount: target.row_count,
          createdAt: "2026-01-01T10:00:00Z", lastSyncAt: target.last_sync_at, createdByName: "Maria",
          columnMapping: { date: "Dia da venda", revenue: "Valor líquido", customer: "Nome cliente" }, dateRange: { from: "2024-01-01", to: "2024-12-31" },
        };
      }
      if (path === "/api/notifications") return notificationsPayload;
      if (path === "/api/notifications/read") return { marked: 1 };
      if (path.startsWith("/api/analytics/full")) return analyticsPayload;
      if (path.startsWith("/api/decisions")) return { decisions: [] };
      throw new Error(`unexpected request ${path}`);
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  const openApp = async (role = "owner") => {
    wrap(<DecisionOSApp user={{ id: "me", name: "Maria", email: "maria@acme.pt", orgName: "Acme Lda", role }} onLogout={() => {}} />);
    // the header leaves the demo data once the list has loaded (it names the file, or says "N ficheiros")
    await waitFor(() => expect(pillText()).not.toMatch(/demonstração/i));
    fireEvent.click(screen.getByRole("button", { name: "Dados" }));
    await screen.findAllByTestId("source-row");
  };
  const analyticsCalls = () => calls.filter((c) => c === "GET /api/analytics/full").length;
  const switchFor = (name) => screen.getByRole("switch", { name: `Incluir "${name}" na análise` });
  const pillText = () => within(screen.getByRole("banner")).getByText(/ligado/).closest("button").textContent;

  it("starts with the files the server says are included, and lists every file on the Data page", async () => {
    await openApp();
    const rows = screen.getAllByTestId("source-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-included", "true");
    expect(rows[1]).toHaveAttribute("data-included", "false");
    expect(within(rows[1]).getByText("vendas-2024.xlsx")).toBeInTheDocument();
    expect(pillText()).toMatch(/vendas-2025\.xlsx.*ligado/);
  });

  it("including a second file adds it to the analysis: both count, the header says '2 ficheiros', analytics are asked for again", async () => {
    await openApp();
    const before = analyticsCalls();

    fireEvent.click(switchFor("vendas-2024.xlsx"));

    await waitFor(() => expect(calls).toContain("POST /api/datasources/a/activate"));
    await waitFor(() => {
      const rows = screen.getAllByTestId("source-row");
      expect(rows[0]).toHaveAttribute("data-included", "true"); // still in — it was added to, not replaced
      expect(rows[1]).toHaveAttribute("data-included", "true");
    });
    await waitFor(() => expect(pillText()).toMatch(/2 ficheiros.*ligado/));
    expect(screen.getByTestId("included-summary")).toHaveTextContent(/2 de 2 ficheiros incluídos na análise · 1\D?078 linhas/);
    // and the dashboards were recomputed for the new set (not served from the previous one)
    await waitFor(() => expect(analyticsCalls()).toBeGreaterThan(before));
    expect(await screen.findByText(/"vendas-2024\.xlsx" incluído na análise\./)).toBeInTheDocument(); // toast
  });

  it("taking one of two files out returns to that single file; the last one can't be switched off", async () => {
    included = new Set(["b", "a"]);
    await openApp();
    await waitFor(() => expect(pillText()).toMatch(/2 ficheiros/));

    fireEvent.click(switchFor("vendas-2025.xlsx"));
    await waitFor(() => expect(calls).toContain("POST /api/datasources/b/activate"));
    await waitFor(() => expect(pillText()).toMatch(/vendas-2024\.xlsx.*ligado/));
    expect(await screen.findByText(/"vendas-2025\.xlsx" retirado da análise\./)).toBeInTheDocument();

    expect(switchFor("vendas-2024.xlsx")).toBeDisabled(); // the last included file
    expect(switchFor("vendas-2025.xlsx")).toBeEnabled(); // and the other one can come back
  });

  it("shows the server's message when a change is refused", async () => {
    await openApp();
    apiFetch.mockImplementationOnce(async () => { throw new Error("requires role 'manager' or higher"); });
    fireEvent.click(switchFor("vendas-2024.xlsx"));
    expect(await screen.findByText("requires role 'manager' or higher")).toBeInTheDocument();
    expect(screen.getAllByTestId("source-row")[1]).toHaveAttribute("data-included", "false"); // nothing changed
  });

  it("a file that repeats rows of an included one asks before it is included — and counts them twice only if the person insists", async () => {
    duplicateOf = { a: [{ dataSourceId: "b", name: "vendas-2025.xlsx", duplicateRowCount: 1234, dateRange: { from: "2025-01-01", to: "2025-12-31" } }] };
    await openApp();

    fireEvent.click(switchFor("vendas-2024.xlsx"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    const question = window.confirm.mock.calls[0][0];
    expect(question).toContain('"vendas-2024.xlsx"');
    expect(question).toMatch(/1\D?234 linhas/);
    expect(question).toContain('"vendas-2025.xlsx"');
    expect(question).toMatch(/a dobrar/);

    // confirmed -> the same request is repeated with the flag
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/datasources/a/activate?ignoreDuplicates=true", { method: "POST" }));
    await waitFor(() => expect(screen.getAllByTestId("source-row")[1]).toHaveAttribute("data-included", "true"));
  });

  it("…and nothing changes when the person says no", async () => {
    duplicateOf = { a: [{ dataSourceId: "b", name: "vendas-2025.xlsx", duplicateRowCount: 5 }] };
    window.confirm.mockReturnValue(false);
    await openApp();

    fireEvent.click(switchFor("vendas-2024.xlsx"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("ignoreDuplicates=true"), expect.anything());
    expect(screen.getAllByTestId("source-row")[1]).toHaveAttribute("data-included", "false");
    expect(switchFor("vendas-2024.xlsx")).toBeEnabled(); // not stuck in a busy state
    expect(screen.queryByText(/incluído na análise\./)).not.toBeInTheDocument();
  });

  it("removing one of two included files keeps the other; removing the last one goes back to upload", async () => {
    included = new Set(["b", "a"]);
    await openApp();

    chooseFromMenu("vendas-2025.xlsx", "Remover");
    await waitFor(() => expect(calls).toContain("DELETE /api/datasources/b"));
    await waitFor(() => expect(screen.getAllByTestId("source-row")).toHaveLength(1));
    const remaining = screen.getByTestId("source-row");
    expect(within(remaining).getByText("vendas-2024.xlsx")).toBeInTheDocument();
    expect(remaining).toHaveAttribute("data-included", "true");
    await waitFor(() => expect(pillText()).toMatch(/vendas-2024\.xlsx.*ligado/));

    chooseFromMenu("vendas-2024.xlsx", "Remover");
    await waitFor(() => expect(calls).toContain("DELETE /api/datasources/a"));
    // nothing left: the onboarding/upload modal is offered again
    await waitFor(() => expect(screen.queryAllByTestId("source-row")).toHaveLength(0));
  });

  it("removing the only included file falls back to the file the server picks", async () => {
    await openApp(); // only b included, a is kept but not counted
    chooseFromMenu("vendas-2025.xlsx", "Remover");
    await waitFor(() => expect(screen.getAllByTestId("source-row")).toHaveLength(1));
    expect(screen.getByTestId("source-row")).toHaveAttribute("data-included", "true"); // a, chosen by the backend fallback
    await waitFor(() => expect(pillText()).toMatch(/vendas-2024\.xlsx.*ligado/));
  });

  it("does nothing when the person cancels the removal", async () => {
    window.confirm.mockReturnValue(false);
    await openApp();
    chooseFromMenu("vendas-2024.xlsx", "Remover");
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(screen.getAllByTestId("source-row")).toHaveLength(2);
  });

  it("the Data Quality Center shows the lowest-quality included file, and says so when several are included", async () => {
    included = new Set(["b", "a"]); // b is 92, a is 65
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Qualidade dos dados" }));

    const note = await screen.findByTestId("dq-scope-note");
    expect(note).toHaveTextContent('A mostrar o ficheiro com pior qualidade dos 2 incluídos na análise: "vendas-2024.xlsx"');
    expect(await screen.findByText("65%")).toBeInTheDocument(); // a's score, not b's 92%
    expect(calls).toContain("GET /api/datasources/a/quality");
    expect(within(screen.getByRole("main")).getByText("vendas-2024.xlsx")).toBeInTheDocument(); // its name in the Source card
  });

  it("with a single included file the Quality Center shows it plainly, without the note", async () => {
    await openApp();
    fireEvent.click(screen.getByRole("button", { name: "Qualidade dos dados" }));
    expect(await screen.findByText("92%")).toBeInTheDocument();
    expect(screen.queryByTestId("dq-scope-note")).toBeNull();
    expect(calls).toContain("GET /api/datasources/b/quality");
  });

  it("adding a file that duplicates an included one keeps it out and tells the person why", async () => {
    await openApp();
    apiUpload.mockResolvedValueOnce({ stagingId: "st-1", suggestedMapping: { date: "Data", revenue: "Receita" } });
    pollJob.mockResolvedValueOnce({
      status: "completed",
      result: { imported: 958, skipped: 0, included: false, duplicateOverlaps: [{ dataSourceId: "b", name: "vendas-2025.xlsx", duplicateRowCount: 958 }], dataQuality: { score: 90, issues: [] } },
    });

    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(["x"], "vendas-2025 (copia).xlsx")] } });

    expect(await screen.findByText(/ficou de fora da análise: parece um duplicado de "vendas-2025\.xlsx"/)).toBeInTheDocument();
    expect(screen.queryByText(/foi adicionado|importadas|Importad/)).not.toBeInTheDocument(); // no "all good" toast
    expect(calls).toContain("POST /api/datasources/excel/commit");
  });

  it("adding a normal file confirms the import and refreshes the list", async () => {
    await openApp();
    apiUpload.mockResolvedValueOnce({ stagingId: "st-2", suggestedMapping: { date: "Data", revenue: "Receita" } });
    pollJob.mockResolvedValueOnce({ status: "completed", result: { imported: 500, skipped: 0, included: true, duplicateOverlaps: [], dataQuality: { score: 95, issues: [] } } });
    const listCallsBefore = calls.filter((c) => c === "GET /api/datasources").length;

    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [new File(["x"], "novo.xlsx")] } });

    await waitFor(() => expect(calls.filter((c) => c === "GET /api/datasources").length).toBeGreaterThan(listCallsBefore));
    expect(screen.queryByText(/ficou de fora da análise/)).not.toBeInTheDocument();
  });

  it("gives viewers the list but no way to change it", async () => {
    await openApp("viewer");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: /Adicionar ficheiro/ })).not.toBeInTheDocument();
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

  it("opens the details of a file that is NOT included: period, mapping and its own quality report", async () => {
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
    expect(await within(dialog).findByText("65% saudável")).toBeInTheDocument(); // its own report, not the included file's 92%
    expect(within(dialog).getByText("65,0% das receitas são válidas")).toBeInTheDocument();
    expect(calls).toContain("GET /api/datasources/a");
    expect(calls).toContain("GET /api/datasources/a/quality");
    expect(calls).not.toContain("POST /api/datasources/a/activate"); // looking is not switching

    fireEvent.click(within(dialog).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("the avatar opens a user menu with the way into 'My account' (and the Team tab for an owner)", async () => {
    await openApp("owner");
    fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
    expect(screen.getByText("maria@acme.pt")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "A minha conta" }));
    expect(await screen.findByRole("heading", { name: "A minha conta" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Equipa" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Perfil", selected: true })).toBeInTheDocument();
  });

  it("'Equipa' in the user menu goes straight to the team tab; a viewer has neither the menu entry nor the tab", async () => {
    await openApp("owner");
    apiFetch.mockImplementation(async (path, opts = {}) => (path === "/api/org/users" ? { users: [] } : path === "/api/notifications" ? notificationsPayload : { dataSources: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Equipa" }));
    expect(await screen.findByRole("tab", { name: "Equipa", selected: true })).toBeInTheDocument();
    expect(await screen.findByText("Adicionar colaborador")).toBeInTheDocument();
  });

  it("a viewer's menu has no Team entry, and the account page only offers the profile", async () => {
    await openApp("viewer");
    fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
    expect(screen.queryByRole("menuitem", { name: "Equipa" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "A minha conta" }));
    expect(await screen.findByRole("heading", { name: "A minha conta" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Equipa" })).not.toBeInTheDocument();
  });

  it("the user menu still signs out", async () => {
    const onLogout = vi.fn();
    wrap(<DecisionOSApp user={{ id: "me", name: "Maria", orgName: "Acme Lda", role: "owner" }} onLogout={onLogout} />);
    await screen.findByText("vendas-2025.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminar sessão" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it("the account page opens even when there is no data to analyse", async () => {
    await openApp("owner");
    apiFetch.mockImplementation(async (path) => { throw new Error("analytics are down"); });
    fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "A minha conta" }));
    expect(await screen.findByRole("heading", { name: "A minha conta" })).toBeInTheDocument();
  });

  it("a notification in the bell takes you to the page it is about and counts down as you read", async () => {
    notificationsPayload = {
      unreadCount: 1,
      notifications: [{ key: "import_failed:j1", kind: "import_failed", severity: "red", params: { name: "partido.xlsx", error: "file is empty" }, createdAt: new Date().toISOString(), target: { view: "data" }, read: false }],
    };
    wrap(<DecisionOSApp user={{ id: "me", name: "Maria", orgName: "Acme Lda", role: "owner" }} onLogout={() => {}} />);
    await screen.findByText("vendas-2025.xlsx");
    expect(await screen.findByTestId("bell-badge")).toHaveTextContent("1");

    fireEvent.click(screen.getByRole("button", { name: /Notificações \(1 por ler\)/ }));
    fireEvent.click(await screen.findByText("Falhou a importação de partido.xlsx"));

    expect(await screen.findAllByTestId("source-row")).not.toHaveLength(0); // landed on the Data page
    expect(apiFetch).toHaveBeenCalledWith("/api/notifications/read", { method: "POST", body: { keys: ["import_failed:j1"] } });
    expect(screen.queryByTestId("bell-badge")).not.toBeInTheDocument();
  });
});
