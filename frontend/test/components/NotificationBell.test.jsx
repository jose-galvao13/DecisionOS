import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ThemeModeProvider } from "../../src/lib/theme";
import { LangProvider } from "../../src/lib/i18n";

vi.mock("../../src/api/client", () => ({ apiFetch: vi.fn() }));
import { apiFetch } from "../../src/api/client";
import NotificationBell from "../../src/components/NotificationBell";

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const item = (over) => ({ key: "k", kind: "approval_pending", severity: "yellow", params: { title: "Subir preços", by: "Ana" }, createdAt: minutesAgo(5), target: { view: "decisionLog" }, read: false, ...over });
const PAYLOAD = () => ({
  unreadCount: 2,
  notifications: [
    item({ key: "approval_pending:d1" }),
    item({ key: "risk:revenue_decline:480:2026-08-31", kind: "risk", severity: "red", params: { type: "revenue_decline", impact: { value: 12000, currency: "EUR" } }, createdAt: null, target: { view: "overview" } }),
    item({ key: "decision_approved:d2", kind: "decision_approved", severity: "green", params: { title: "Cortar custos" }, target: { view: "decisionLog" }, read: true }),
  ],
});

let server;
const setup = (onNavigate = vi.fn()) => {
  render(<ThemeModeProvider><LangProvider><NotificationBell onNavigate={onNavigate} /></LangProvider></ThemeModeProvider>);
  return onNavigate;
};
const openBell = () => fireEvent.click(screen.getByRole("button", { name: /^Notificações/ }));
const posted = () => apiFetch.mock.calls.filter(([p]) => p === "/api/notifications/read");

beforeEach(() => {
  server = PAYLOAD();
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path) => (path === "/api/notifications" ? server : { marked: 1 }));
});
afterEach(() => vi.useRealTimers());

describe("NotificationBell", () => {
  it("shows how many are unread on the bell itself", async () => {
    setup();
    expect(await screen.findByTestId("bell-badge")).toHaveTextContent("2");
    expect(screen.getByRole("button", { name: "Notificações (2 por ler)" })).toBeInTheDocument();
  });

  it("has no badge when there is nothing unread, and caps the number at 9+", async () => {
    server = { unreadCount: 0, notifications: [] };
    const { unmount } = render(<ThemeModeProvider><LangProvider><NotificationBell /></LangProvider></ThemeModeProvider>);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByTestId("bell-badge")).not.toBeInTheDocument();
    unmount();

    server = { unreadCount: 14, notifications: [item()] };
    setup();
    expect(await screen.findByTestId("bell-badge")).toHaveTextContent("9+");
  });

  it("lists the notifications in the person's language, with what happened and when", async () => {
    setup();
    await screen.findByTestId("bell-badge");
    openBell();
    const dialog = screen.getByRole("dialog", { name: "Notificações" });
    expect(dialog).toHaveTextContent("Decisão à espera de aprovação");
    expect(dialog).toHaveTextContent('"Subir preços" — proposta por Ana');
    expect(dialog).toHaveTextContent("Queda de receita");
    expect(dialog).toHaveTextContent("Impacto estimado: €12.0K");
    expect(dialog).toHaveTextContent("A sua decisão foi aprovada");
    expect(dialog).toHaveTextContent(/há 5 minutos/);
  });

  it("refreshes when opened", async () => {
    setup();
    await screen.findByTestId("bell-badge");
    const before = apiFetch.mock.calls.filter(([p]) => p === "/api/notifications").length;
    openBell();
    await waitFor(() => expect(apiFetch.mock.calls.filter(([p]) => p === "/api/notifications").length).toBe(before + 1));
  });

  it("clicking one marks it read, goes to the page it is about and closes the panel", async () => {
    const onNavigate = setup();
    await screen.findByTestId("bell-badge");
    openBell();
    fireEvent.click(screen.getByText("Decisão à espera de aprovação"));

    expect(onNavigate).toHaveBeenCalledWith("decisionLog");
    expect(posted()).toEqual([["/api/notifications/read", { method: "POST", body: { keys: ["approval_pending:d1"] } }]]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("bell-badge")).toHaveTextContent("1");
  });

  it("clicking one that was already read navigates without marking anything again", async () => {
    const onNavigate = setup();
    await screen.findByTestId("bell-badge");
    openBell();
    fireEvent.click(screen.getByText("A sua decisão foi aprovada"));
    expect(onNavigate).toHaveBeenCalledWith("decisionLog");
    expect(posted()).toHaveLength(0);
  });

  it("'mark all as read' clears the badge and tells the server", async () => {
    setup();
    await screen.findByTestId("bell-badge");
    openBell();
    fireEvent.click(screen.getByRole("button", { name: "Marcar tudo como lido" }));
    expect(posted()).toEqual([["/api/notifications/read", { method: "POST", body: { all: true } }]]);
    expect(screen.queryByTestId("bell-badge")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Marcar tudo como lido" })).not.toBeInTheDocument();
  });

  it("says so when everything is in order", async () => {
    server = { unreadCount: 0, notifications: [] };
    setup();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    openBell();
    expect(await screen.findByText("Tudo em dia")).toBeInTheDocument();
  });

  it("says so when it can't load, and can try again", async () => {
    apiFetch.mockImplementation(async () => { throw new Error("offline"); });
    setup();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    openBell();
    expect(await screen.findByText("Não foi possível carregar as notificações.")).toBeInTheDocument();

    apiFetch.mockImplementation(async (path) => (path === "/api/notifications" ? PAYLOAD() : { marked: 1 }));
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(await screen.findByText("Decisão à espera de aprovação")).toBeInTheDocument();
  });

  it("keeps showing what it had when a refresh fails", async () => {
    setup();
    await screen.findByTestId("bell-badge");
    apiFetch.mockImplementation(async () => { throw new Error("offline"); });
    openBell();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Decisão à espera de aprovação")).toBeInTheDocument();
    expect(screen.queryByText("Não foi possível carregar as notificações.")).not.toBeInTheDocument();
  });

  it("checks again every minute while the tab is visible — and not while it is hidden", async () => {
    vi.useFakeTimers();
    setup();
    await act(async () => {});
    const count = () => apiFetch.mock.calls.filter(([p]) => p === "/api/notifications").length;
    expect(count()).toBe(1);
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(count()).toBe(2);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(count()).toBe(2);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("closes on Escape and gives focus back to the bell", async () => {
    setup();
    await screen.findByTestId("bell-badge");
    openBell();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Notificações/ })).toHaveFocus();
  });
});
