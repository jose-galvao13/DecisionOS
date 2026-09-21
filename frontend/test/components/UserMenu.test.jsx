import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeModeProvider } from "../../src/lib/theme";
import { LangProvider } from "../../src/lib/i18n";
import UserMenu from "../../src/components/UserMenu";

const setup = (user, handlers = {}) => {
  const props = { onNavigate: vi.fn(), onLogout: vi.fn(), ...handlers };
  render(<ThemeModeProvider><LangProvider><UserMenu user={user} {...props} /></LangProvider></ThemeModeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
  return props;
};
const admin = { id: "a", name: "Maria Santos", email: "maria@acme.pt", role: "admin", orgName: "Acme Lda" };

describe("UserMenu", () => {
  it("shows the initials on the avatar and who you are inside", () => {
    setup(admin);
    expect(screen.getByRole("button", { name: "Menu do utilizador" })).toHaveTextContent("MS");
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("Maria Santos");
    expect(menu).toHaveTextContent("maria@acme.pt");
    expect(menu).toHaveTextContent("Administrador");
    expect(menu).toHaveTextContent("Acme Lda");
  });

  it("offers My account, Team (admins) and Sign out", () => {
    setup(admin);
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["A minha conta", "Equipa", "Terminar sessão"]);
  });

  it("doesn't offer Team to people who can't manage one", () => {
    setup({ ...admin, role: "manager" });
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["A minha conta", "Terminar sessão"]);
  });

  it("goes to the right tab, and signs out", () => {
    const p = setup(admin);
    fireEvent.click(screen.getByRole("menuitem", { name: "Equipa" }));
    expect(p.onNavigate).toHaveBeenCalledWith("team");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "A minha conta" }));
    expect(p.onNavigate).toHaveBeenLastCalledWith("profile");

    fireEvent.click(screen.getByRole("button", { name: "Menu do utilizador" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminar sessão" }));
    expect(p.onLogout).toHaveBeenCalledTimes(1);
  });

  it("moves through the items with the arrow keys and closes on Escape", () => {
    setup(admin);
    const [first, second] = screen.getAllByRole("menuitem");
    expect(first).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
