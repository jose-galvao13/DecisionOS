import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LangContext, translate } from "../../src/lib/i18n";
import ReportsPage from "../../src/pages/Analytics/ReportsPage";
import { computeAnalytics } from "../../src/lib/metrics";
import { generateDemoTransactions } from "../../src/lib/demoData";

const renderIn = (lang, analytics, sourceInfo = { type: "demo", name: "", rows: 0 }) => {
  const value = { lang, setLang() {}, t: (k, v) => translate(lang, k, v), locale: lang === "pt" ? "pt-PT" : "en-US" };
  return render(
    <LangContext.Provider value={value}>
      <ReportsPage analytics={analytics} sourceInfo={sourceInfo} />
    </LangContext.Provider>
  );
};

describe("ReportsPage", () => {
  const analytics = computeAnalytics(generateDemoTransactions(), "pt-PT");

  it("renders the executive report in Portuguese with no raw i18n keys", () => {
    const { container } = renderIn("pt", analytics);
    const text = container.textContent;
    expect(screen.getAllByText("Resumo executivo").length).toBeGreaterThan(0);
    expect(text).toContain("Principais riscos");
    expect(text).toContain("Principais oportunidades");
    expect(text).toContain("O que está a mudar?");
    expect(text).toContain("Principais produtos");
    // any leaked key looks like "namespace.camelCase"
    expect(text.match(/\b(reports|kpi|dim|products|customers|forecast|bridge|alerts|chart|series|nav)\.[a-zA-Z.]+/g)).toBeNull();
  });

  it("renders in English too", () => {
    const { container } = renderIn("en", analytics);
    expect(container.textContent).toContain("Top risks");
    expect(container.textContent).toContain("Export (Print / PDF)");
  });

  it("shows an empty state without analytics", () => {
    renderIn("pt", null);
    expect(screen.getByText("Ainda não há dados ligados.")).toBeTruthy();
  });
});
