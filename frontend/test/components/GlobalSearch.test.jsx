import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeModeProvider } from "../../src/lib/theme";
import { LangProvider } from "../../src/lib/i18n";
import GlobalSearch, { fold, scoreText, tokenize } from "../../src/components/GlobalSearch";

const Icon = () => <svg />;
const pages = [
  { id: "overview", key: "nav.overview", icon: Icon },
  { id: "profit", key: "nav.profit", icon: Icon },
  { id: "data", key: "nav.data", icon: Icon },
];
const analytics = {
  byProduct: [{ product: "Café Premium" }, { product: "Chá Verde" }],
  byRegion: [{ region: "Lisboa" }, { region: "Porto" }],
  byChannel: [{ channel: "Online" }],
};
const sources = [{ id: "s1", name: "vendas_2024.xlsx" }];

const setup = () => {
  const onSelect = vi.fn();
  render(<ThemeModeProvider><LangProvider><GlobalSearch pages={pages} analytics={analytics} sources={sources} onSelect={onSelect} /></LangProvider></ThemeModeProvider>);
  return { onSelect, input: screen.getByRole("combobox") };
};

describe("search helpers", () => {
  it("folds case and accents without changing length", () => {
    expect(fold("Visão Geral")).toBe("visao geral");
    expect(fold("Café").length).toBe(4);
  });
  it("requires every word to match and ranks starts-with first", () => {
    expect(scoreText("Café Premium", tokenize("cafe prem"))).toBeLessThan(Infinity);
    expect(scoreText("Café Premium", tokenize("cafe xyz"))).toBe(Infinity);
    expect(scoreText("Café", tokenize("caf"))).toBeLessThan(scoreText("Descafeinado", tokenize("caf")));
  });
});

describe("GlobalSearch", () => {
  it("lists the pages when focused with nothing typed", () => {
    const { input } = setup();
    fireEvent.focus(input);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Visão geral", "Profit Intelligence", "Dados"]);
  });

  it("finds products ignoring accents and applies them as a filter", () => {
    const { input, onSelect } = setup();
    fireEvent.change(input, { target: { value: "cafe" } });
    const opt = screen.getByRole("option", { name: /Café Premium/ });
    fireEvent.click(opt);
    expect(onSelect).toHaveBeenCalledWith({ type: "filter", dim: "product", value: "Café Premium" });
  });

  it("finds pages by meaning, not only by title", () => {
    const { input, onSelect } = setup();
    fireEvent.change(input, { target: { value: "margem" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ type: "page", id: "profit" });
  });

  it("finds uploaded files and opens the data page", () => {
    const { input, onSelect } = setup();
    fireEvent.change(input, { target: { value: "vendas" } });
    fireEvent.click(screen.getByRole("option", { name: /vendas_2024/ }));
    expect(onSelect).toHaveBeenCalledWith({ type: "source", id: "s1" });
  });

  it("moves with the arrow keys and selects with Enter", () => {
    const { input, onSelect } = setup();
    fireEvent.change(input, { target: { value: "o" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("says so when nothing matches, and clears with the X button", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByText(/Sem resultados/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar pesquisa" }));
    expect(input).toHaveValue("");
  });

  it("closes on Escape", () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: "lis" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
