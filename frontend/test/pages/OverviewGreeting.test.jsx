import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { LangContext, translate } from "../../src/lib/i18n";
import { computeAnalytics } from "../../src/lib/metrics";
import { generateDemoTransactions } from "../../src/lib/demoData";
import { ToastProvider } from "../../src/components/ui";

vi.mock("../../src/api/client", () => ({
  apiFetch: vi.fn(() => Promise.reject(new Error("no backend"))),
}));
import Overview from "../../src/pages/Dashboard/Overview";

const analytics = computeAnalytics(generateDemoTransactions(), "pt-PT");
const sourceInfo = { type: "demo", name: "", rows: 0 };
const filters = { period: "all", product: "all", region: "all", channel: "all" };

function renderOverview({ user, lang = "pt", hour = 15 }) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 20, hour, 0, 0)); // local time
  const value = { lang, setLang() {}, t: (k, v) => translate(lang, k, v), locale: lang === "pt" ? "pt-PT" : "en-US" };
  return render(
    <LangContext.Provider value={value}>
      <ToastProvider>
        <Overview analytics={analytics} sourceInfo={sourceInfo} execMode={true} filters={filters} user={user} />
      </ToastProvider>
    </LangContext.Provider>
  );
}

afterEach(() => vi.useRealTimers());

describe("Overview greeting", () => {
  it("greets the organization the person registered, not the person", () => {
    renderOverview({ user: { name: "Maria Silva", orgName: "Acme Lda" } });
    expect(screen.getByText("Boa tarde, Acme Lda")).toBeInTheDocument();
    expect(screen.queryByText(/Maria/)).not.toBeInTheDocument();
  });

  it("changes with the organization", () => {
    const { unmount } = renderOverview({ user: { name: "Ana", orgName: "Alfa SA" } });
    expect(screen.getByText("Boa tarde, Alfa SA")).toBeInTheDocument();
    unmount();
    renderOverview({ user: { name: "Ana", orgName: "Beta Lda" }, lang: "en", hour: 9 });
    expect(screen.getByText("Good morning, Beta Lda")).toBeInTheDocument();
  });

  it("without an organization name, falls back to the first name (never a hardcoded company)", () => {
    const { container } = renderOverview({ user: { name: "Maria Silva" } });
    expect(screen.getByText("Boa tarde, Maria")).toBeInTheDocument();
    expect(container.textContent).not.toContain("Nortica");
  });

  it("changes with who is logged in", () => {
    const { unmount } = renderOverview({ user: { name: "Maria Silva" } });
    expect(screen.getByText("Boa tarde, Maria")).toBeInTheDocument();
    unmount();
    renderOverview({ user: { name: "  João   Costa " } });
    expect(screen.getByText("Boa tarde, João")).toBeInTheDocument();
  });

  it("follows the time of day", () => {
    for (const [hour, text] of [[4, "Boa noite, Ana"], [5, "Bom dia, Ana"], [11, "Bom dia, Ana"], [12, "Boa tarde, Ana"], [18, "Boa tarde, Ana"], [19, "Boa noite, Ana"], [23, "Boa noite, Ana"]]) {
      const { unmount } = renderOverview({ user: { name: "Ana" }, hour });
      expect(screen.getByText(text), `hour ${hour}`).toBeInTheDocument();
      unmount();
    }
  });

  it("works in English", () => {
    renderOverview({ user: { name: "Maria Silva" }, lang: "en", hour: 9 });
    expect(screen.getByText("Good morning, Maria")).toBeInTheDocument();
  });

  it("falls back to a plain greeting when there is no name", () => {
    renderOverview({ user: undefined });
    expect(screen.getByText("Boa tarde")).toBeInTheDocument();
    renderOverview({ user: { name: "   " } });
    expect(screen.getAllByText("Boa tarde").length).toBe(2);
  });
});
