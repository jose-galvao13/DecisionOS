import React from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeModeProvider, useThemeMode, tint } from "../../src/lib/theme";
import ThemeSwitch from "../../src/components/ThemeSwitch";

function Probe() {
  const { mode, toggle } = useThemeMode();
  return <button onClick={toggle}>mode:{mode}</button>;
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("tint()", () => {
  it("builds a color-mix() expression around the given color at the given percentage", () => {
    expect(tint("var(--blue)")).toBe("color-mix(in srgb, var(--blue) 15%, transparent)");
    expect(tint("var(--green)", 30)).toBe("color-mix(in srgb, var(--green) 30%, transparent)");
  });
});

describe("ThemeModeProvider / useThemeMode", () => {
  it("defaults to light when there's no stored preference and the OS prefers light (matchMedia stub returns matches:false)", () => {
    render(<ThemeModeProvider><Probe /></ThemeModeProvider>);
    expect(screen.getByText("mode:light")).toBeInTheDocument();
  });

  it("reads a previously-stored preference instead of the OS default", () => {
    window.localStorage.setItem("decisionos-theme", "dark");
    render(<ThemeModeProvider><Probe /></ThemeModeProvider>);
    expect(screen.getByText("mode:dark")).toBeInTheDocument();
  });

  it("toggle() flips the mode, updates <html data-theme>, and persists to localStorage", () => {
    render(<ThemeModeProvider><Probe /></ThemeModeProvider>);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    fireEvent.click(screen.getByText("mode:light"));
    expect(screen.getByText("mode:dark")).toBeInTheDocument();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem("decisionos-theme")).toBe("dark");
    expect(window.localStorage.getItem("decisionos-theme-explicit")).toBe("1");
  });
});

describe("ThemeSwitch", () => {
  it("clicking the moon/sun buttons calls setMode with the right value", () => {
    render(<ThemeModeProvider><ThemeSwitch /><Probe /></ThemeModeProvider>);
    fireEvent.click(screen.getByLabelText("Dark theme"));
    expect(screen.getByText("mode:dark")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Light theme"));
    expect(screen.getByText("mode:light")).toBeInTheDocument();
  });
});
