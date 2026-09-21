import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ThemeModeProvider } from "../../src/lib/theme";
import { LangProvider } from "../../src/lib/i18n";
import { ToastProvider } from "../../src/components/ui";

vi.mock("../../src/api/client", () => ({ apiFetch: vi.fn(), setToken: vi.fn(), getToken: vi.fn(() => null) }));
import { apiFetch, setToken } from "../../src/api/client";
import AccountPage from "../../src/pages/Account/AccountPage";

const wrap = (ui) => render(<ThemeModeProvider><LangProvider><ToastProvider>{ui}</ToastProvider></LangProvider></ThemeModeProvider>);
const person = (role, over = {}) => ({ id: "me", name: "Maria Santos", email: "maria@acme.pt", role, orgName: "Acme Lda", ...over });

const MEMBERS = [
  { id: "me", name: "Maria Santos", email: "maria@acme.pt", role: "owner", created_at: "2026-01-01T00:00:00Z", disabled_at: null },
  { id: "adm", name: "Rui Admin", email: "rui@acme.pt", role: "admin", created_at: "2026-02-01T00:00:00Z", disabled_at: null },
  { id: "man", name: "Sofia Gestora", email: "sofia@acme.pt", role: "manager", created_at: "2026-03-01T00:00:00Z", disabled_at: null },
  { id: "old", name: "Pedro Antigo", email: "pedro@acme.pt", role: "viewer", created_at: "2026-04-01T00:00:00Z", disabled_at: "2026-09-01T00:00:00Z" },
];
let members;
let calls;
const sent = (method, path) => apiFetch.mock.calls.filter(([p, o]) => p === path && (o?.method || "GET") === method);

beforeEach(() => {
  members = MEMBERS.map((m) => ({ ...m }));
  calls = [];
  apiFetch.mockReset();
  setToken.mockReset();
  apiFetch.mockImplementation(async (path, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${path}`);
    if (path === "/api/org/users" && !opts.method) return { users: members };
    if (path === "/api/org/users" && opts.method === "POST") return { id: "new1", name: opts.body.name, email: opts.body.email.toLowerCase(), role: opts.body.role };
    return { ok: true };
  });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

/* ------------------------------------------------------------------ */
describe("AccountPage — tabs", () => {
  it("everyone gets the profile; only admins and owners get the Team tab", () => {
    for (const role of ["viewer", "manager", "finance"]) {
      const { unmount } = wrap(<AccountPage user={person(role)} tab="team" />);
      expect(screen.queryByRole("tab", { name: "Equipa" })).not.toBeInTheDocument();
      // asking for the team tab anyway lands on the profile: never a tab you can't use
      expect(screen.getByRole("tab", { name: "Perfil", selected: true })).toBeInTheDocument();
      expect(screen.queryByText("Adicionar colaborador")).not.toBeInTheDocument();
      unmount();
    }
    for (const role of ["admin", "owner"]) {
      const { unmount } = wrap(<AccountPage user={person(role)} tab="profile" />);
      expect(screen.getByRole("tab", { name: "Equipa" })).toBeInTheDocument();
      unmount();
    }
  });

  it("switching tabs is reported to the parent", () => {
    const onTabChange = vi.fn();
    wrap(<AccountPage user={person("owner")} tab="profile" onTabChange={onTabChange} />);
    fireEvent.click(screen.getByRole("tab", { name: "Equipa" }));
    expect(onTabChange).toHaveBeenCalledWith("team");
  });
});

/* ------------------------------------------------------------------ */
describe("Profile", () => {
  it("shows who you are", () => {
    wrap(<AccountPage user={person("manager")} tab="profile" />);
    expect(screen.getByText("Maria Santos")).toBeInTheDocument();
    expect(screen.getByText("maria@acme.pt")).toBeInTheDocument();
    expect(screen.getAllByText("Acme Lda")).toHaveLength(2); // page eyebrow + profile card
    expect(screen.getByText("Gestor")).toBeInTheDocument();
  });

  const fill = (current, next, confirm) => {
    fireEvent.change(screen.getByLabelText("Palavra-passe atual"), { target: { value: current } });
    fireEvent.change(screen.getByLabelText("Nova palavra-passe"), { target: { value: next } });
    fireEvent.change(screen.getByLabelText("Confirmar nova palavra-passe"), { target: { value: confirm } });
  };
  const submit = () => fireEvent.click(screen.getByRole("button", { name: "Alterar palavra-passe" }));

  it("changes the password and keeps this browser signed in with the fresh token the server returns", async () => {
    apiFetch.mockResolvedValueOnce({ token: "fresh.jwt.token" });
    wrap(<AccountPage user={person("viewer")} tab="profile" />);
    fill("old-password-1", "new-password-22", "new-password-22");
    submit();
    await waitFor(() => expect(setToken).toHaveBeenCalledWith("fresh.jwt.token"));
    expect(apiFetch).toHaveBeenCalledWith("/api/auth/change-password", { method: "POST", body: { currentPassword: "old-password-1", newPassword: "new-password-22" } });
    expect(await screen.findByText("Palavra-passe alterada.")).toBeInTheDocument();
    expect(screen.getByLabelText("Palavra-passe atual")).toHaveValue(""); // no password left sitting in the form
    expect(screen.getByLabelText("Nova palavra-passe")).toHaveValue("");
  });

  it("checks the two new passwords match and are long enough before asking the server", () => {
    wrap(<AccountPage user={person("viewer")} tab="profile" />);
    fill("old-password-1", "new-password-22", "different-one");
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("As palavras-passe não coincidem.");
    fill("old-password-1", "short", "short");
    submit();
    expect(screen.getByRole("alert")).toHaveTextContent("pelo menos 8 caracteres");
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("shows the server's reason when it refuses (wrong current password) and does not touch the token", async () => {
    apiFetch.mockRejectedValueOnce(new Error("the current password is incorrect"));
    wrap(<AccountPage user={person("viewer")} tab="profile" />);
    fill("guess", "new-password-22", "new-password-22");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("the current password is incorrect");
    expect(setToken).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Nova palavra-passe")).toHaveValue("new-password-22"); // kept, so they can fix just the current one
  });

  it("can show and hide what is being typed", () => {
    wrap(<AccountPage user={person("viewer")} tab="profile" />);
    const field = screen.getByLabelText("Nova palavra-passe");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.click(screen.getAllByRole("button", { name: "Mostrar palavra-passe" })[1]);
    expect(field).toHaveAttribute("type", "text");
  });
});

/* ------------------------------------------------------------------ */
describe("Team — adding a colleague", () => {
  const openTeam = async (role = "owner") => {
    wrap(<AccountPage user={person(role)} tab="team" />);
    await screen.findAllByTestId("member-row");
  };
  const fillForm = ({ name = "Ana Silva", email = "Ana@Acme.pt", password = "s3guraPass!", role } = {}) => {
    fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: name } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
    fireEvent.change(screen.getByLabelText("Palavra-passe inicial"), { target: { value: password } });
    if (role) fireEvent.change(screen.getByLabelText("Função"), { target: { value: role } });
  };
  const create = () => fireEvent.click(screen.getByRole("button", { name: "Criar colaborador" }));

  it("creates the account from name + email + password + role, then shows the credentials to hand over", async () => {
    await openTeam();
    fillForm({ role: "manager" });
    create();

    await waitFor(() => expect(sent("POST", "/api/org/users")).toHaveLength(1));
    expect(sent("POST", "/api/org/users")[0][1].body).toEqual({ name: "Ana Silva", email: "Ana@Acme.pt", password: "s3guraPass!", role: "manager" });

    const notice = await screen.findByRole("status", { name: "Credenciais de Ana Silva" });
    expect(notice).toHaveTextContent("Credenciais de Ana Silva");
    expect(notice).toHaveTextContent("ana@acme.pt");
    expect(notice).toHaveTextContent("s3guraPass!");
    expect(await screen.findByText("Ana Silva foi adicionado à equipa.")).toBeInTheDocument();
    // the form is ready for the next person, and the list was reloaded
    expect(screen.getByLabelText("Nome completo")).toHaveValue("");
    expect(screen.getByLabelText("Palavra-passe inicial")).toHaveValue("");
    expect(calls.filter((c) => c === "GET /api/org/users").length).toBe(2);
  });

  it("defaults to the least access (Consulta) and explains each role", async () => {
    await openTeam();
    expect(screen.getByLabelText("Função")).toHaveValue("viewer");
    expect(screen.getByText("Vê dashboards, relatórios e decisões, sem alterar nada.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Função"), { target: { value: "manager" } });
    expect(screen.getByText("Também carrega ficheiros de dados e aprova decisões.")).toBeInTheDocument();
  });

  it("only an owner can pick Administrador — an admin isn't offered it", async () => {
    await openTeam("owner");
    expect(within(screen.getByLabelText("Função")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Consulta", "Gestor", "Finanças", "Administrador"]);
    document.body.innerHTML = "";
    await openTeam("admin");
    expect(within(screen.getByLabelText("Função")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Consulta", "Gestor", "Finanças"]);
  });

  it("refuses a short password without calling the server", async () => {
    await openTeam();
    fillForm({ password: "abc" });
    create();
    expect(await screen.findByRole("alert")).toHaveTextContent("pelo menos 8 caracteres");
    expect(sent("POST", "/api/org/users")).toHaveLength(0);
  });

  it("shows the server's reason (e.g. the email is already used) and keeps what was typed", async () => {
    await openTeam();
    apiFetch.mockImplementationOnce(async () => { throw new Error("a user with this email already exists"); });
    fillForm({ name: "Ana Silva", email: "ana@acme.pt" });
    create();
    expect(await screen.findByRole("alert")).toHaveTextContent("a user with this email already exists");
    expect(screen.getByLabelText("Nome completo")).toHaveValue("Ana Silva");
    expect(screen.queryByRole("status", { name: /Credenciais/ })).not.toBeInTheDocument(); // no credentials for someone who wasn't created
  });

  it("can't be submitted until name, email and password are filled in", async () => {
    await openTeam();
    expect(screen.getByRole("button", { name: "Criar colaborador" })).toBeDisabled();
    fillForm();
    expect(screen.getByRole("button", { name: "Criar colaborador" })).toBeEnabled();
  });

  it("'Gerar' fills in a strong password and reveals it, so it can actually be read out", async () => {
    await openTeam();
    const field = screen.getByLabelText("Palavra-passe inicial");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.click(screen.getAllByRole("button", { name: "Gerar" })[0]);
    expect(field).toHaveAttribute("type", "text");
    expect(field.value).toHaveLength(14);
  });

  it("the credentials notice can be dismissed", async () => {
    await openTeam();
    fillForm();
    create();
    await screen.findByRole("status", { name: /Credenciais/ });
    fireEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("status", { name: /Credenciais/ })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
describe("Team — the member list", () => {
  const openTeam = async (role = "owner", id = "me") => {
    wrap(<AccountPage user={person(role, { id })} tab="team" />);
    await screen.findAllByTestId("member-row");
  };
  const rowOf = (name) => screen.getAllByTestId("member-row").find((r) => r.textContent.includes(name));
  const menuOf = (name) => within(rowOf(name)).queryByRole("button", { name: `Ações para ${name}` });

  it("lists everyone with who you are and who is deactivated", async () => {
    await openTeam();
    expect(screen.getAllByTestId("member-row")).toHaveLength(4);
    expect(screen.getByText("Membros (4)")).toBeInTheDocument();
    expect(within(rowOf("Maria Santos")).getByText("Você")).toBeInTheDocument();
    expect(within(rowOf("Pedro Antigo")).getByText("Desativado")).toBeInTheDocument();
    expect(within(rowOf("Sofia Gestora")).getByText("sofia@acme.pt", { exact: false })).toBeInTheDocument();
  });

  it("an owner can act on everyone except themselves — and can change roles", async () => {
    await openTeam("owner");
    expect(menuOf("Maria Santos")).not.toBeInTheDocument();
    expect(menuOf("Rui Admin")).toBeInTheDocument();
    expect(menuOf("Sofia Gestora")).toBeInTheDocument();
    expect(within(rowOf("Sofia Gestora")).getByLabelText("Função de Sofia Gestora")).toHaveValue("manager");
    expect(within(rowOf("Maria Santos")).queryByRole("combobox")).not.toBeInTheDocument(); // the owner's own role isn't editable
  });

  it("an admin can't touch other admins or the owner, and can't change roles at all", async () => {
    members = members.map((m) => (m.id === "me" ? { ...m, role: "owner", id: "owner-x" } : m.id === "adm" ? { ...m, id: "admin-me" } : m));
    await openTeam("admin", "admin-me");
    expect(menuOf("Maria Santos")).not.toBeInTheDocument(); // owner
    expect(menuOf("Rui Admin")).not.toBeInTheDocument(); // themselves
    expect(menuOf("Sofia Gestora")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Função de/ })).not.toBeInTheDocument();
  });

  it("changing a role asks the server and says what changed", async () => {
    await openTeam("owner");
    fireEvent.change(within(rowOf("Sofia Gestora")).getByLabelText("Função de Sofia Gestora"), { target: { value: "finance" } });
    await waitFor(() => expect(sent("PATCH", "/api/org/users/man/role")).toHaveLength(1));
    expect(sent("PATCH", "/api/org/users/man/role")[0][1].body).toEqual({ role: "finance" });
    expect(await screen.findByText("Sofia Gestora passou a Finanças.")).toBeInTheDocument();
  });

  it("deactivating asks for confirmation first, then cuts access", async () => {
    await openTeam("owner");
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(menuOf("Sofia Gestora"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Desativar acesso" }));
    expect(sent("POST", "/api/org/users/man/deactivate")).toHaveLength(0);

    fireEvent.click(menuOf("Sofia Gestora"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Desativar acesso" }));
    await waitFor(() => expect(sent("POST", "/api/org/users/man/deactivate")).toHaveLength(1));
    expect(window.confirm).toHaveBeenLastCalledWith(expect.stringContaining("Sofia Gestora"));
    expect(await screen.findByText("Sofia Gestora foi desativado.")).toBeInTheDocument();
  });

  it("a deactivated person can be reactivated (no confirmation needed)", async () => {
    await openTeam("owner");
    fireEvent.click(menuOf("Pedro Antigo"));
    expect(screen.queryByRole("menuitem", { name: "Desativar acesso" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Reativar acesso" }));
    await waitFor(() => expect(sent("POST", "/api/org/users/old/reactivate")).toHaveLength(1));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it("resets a password through a dialog, with the same rules as everywhere else", async () => {
    await openTeam("owner");
    fireEvent.click(menuOf("Sofia Gestora"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Repor palavra-passe" }));
    const dialog = screen.getByRole("dialog", { name: "Repor palavra-passe de Sofia Gestora" });

    fireEvent.change(within(dialog).getByLabelText("Palavra-passe inicial"), { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Repor palavra-passe" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("pelo menos 8 caracteres");
    expect(sent("POST", "/api/org/users/man/reset-password")).toHaveLength(0);

    fireEvent.change(within(dialog).getByLabelText("Palavra-passe inicial"), { target: { value: "brand-new-pass" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Repor palavra-passe" }));
    await waitFor(() => expect(sent("POST", "/api/org/users/man/reset-password")).toHaveLength(1));
    expect(sent("POST", "/api/org/users/man/reset-password")[0][1].body).toEqual({ password: "brand-new-pass" });
    expect(await screen.findByText("Palavra-passe de Sofia Gestora atualizada.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the reset dialog open with the server's reason if it fails", async () => {
    await openTeam("owner");
    fireEvent.click(menuOf("Sofia Gestora"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Repor palavra-passe" }));
    apiFetch.mockImplementationOnce(async () => { throw new Error("you can't manage this user"); });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Palavra-passe inicial"), { target: { value: "brand-new-pass" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Repor palavra-passe" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("you can't manage this user");
  });

  it("says so if the team can't be loaded, and retries", async () => {
    apiFetch.mockImplementationOnce(async () => { throw new Error("requires role 'admin' or higher"); });
    wrap(<AccountPage user={person("owner")} tab="team" />);
    expect(await screen.findByText(/requires role 'admin' or higher/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findAllByTestId("member-row")).toHaveLength(4);
  });
});
