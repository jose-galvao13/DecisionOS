import { describe, it, expect } from "vitest";
import { translate } from "../../src/lib/i18n";
import { portfolioConcentrationCopy } from "../../src/lib/alertCopy";
import { describeNotification } from "../../src/lib/notifications";

// Parte 2, FASE 4 — the "concentração" alert's wording (alertCopy.js) and its
// use as a notification (notifications.js).
const tFor = (lang) => (key, vars) => translate(lang, key, vars);
const LOCALE = { pt: "pt-PT", en: "en-US" };
const params = (over = {}) => ({ ticker: "AAA", nome: "Acme", pesoPct: 40, hhi: 0.345, effectiveN: 2.9, positions: 3, reasons: ["position", "hhi"], maxPositionPct: 25, hhiLimit: 0.2, ...over });

describe("portfolioConcentrationCopy", () => {
  it("both limits crossed (pt): names the ticker, its weight, the limit, the HHI and the effective N", () => {
    const { title, line } = portfolioConcentrationCopy(params(), tFor("pt"), LOCALE.pt);
    expect(title).toBe("Carteira concentrada");
    expect(line).toContain("AAA pesa 40,0% da carteira");
    expect(line).toContain("limite de referência: 25%");
    expect(line).toContain("HHI é 0,35");
    expect(line).toContain("cerca de 2,9 posições");
  });

  it("only the position limit crossed", () => {
    const { line } = portfolioConcentrationCopy(params({ reasons: ["position"] }), tFor("en"), LOCALE.en);
    expect(line).toContain("AAA is 40.0% of the portfolio value, above the 25% reference limit.");
    expect(line).not.toContain("HHI");
  });

  it("only the HHI limit crossed: says which position is the largest", () => {
    const { line } = portfolioConcentrationCopy(params({ pesoPct: 24, hhi: 0.232, effectiveN: 4.3, reasons: ["hhi"] }), tFor("en"), LOCALE.en);
    expect(line).toContain("concentration index (HHI) is 0.23");
    expect(line).toContain("about 4.3 equally-weighted positions");
    expect(line).toContain("The largest position is AAA, at 24.0%");
  });

  it("points at the portfolio analysis and never tells the person to buy or sell", () => {
    for (const lang of ["pt", "en"]) {
      for (const reasons of [["position"], ["hhi"], ["position", "hhi"]]) {
        const { title, line } = portfolioConcentrationCopy(params({ reasons }), tFor(lang), LOCALE[lang]);
        expect(line).toMatch(lang === "pt" ? /na Carteira\./ : /in Portfolio\./);
        expect(`${title} ${line}`).not.toMatch(/vend(a|er)|compr(a|ar)|sell|buy|reduz|reduce/i);
      }
    }
  });
});

describe("describeNotification — portfolio_concentration", () => {
  it("turns the backend's kind + raw params into translated title/body", () => {
    const n = { kind: "portfolio_concentration", severity: "yellow", params: params(), target: { view: "portfolio" } };
    const { title, body } = describeNotification(n, tFor("pt"), LOCALE.pt);
    expect(title).toBe("Carteira concentrada");
    expect(body).toContain("AAA pesa 40,0%");
  });

  it("follows the language switch", () => {
    const n = { kind: "portfolio_concentration", params: params({ reasons: ["position"] }) };
    expect(describeNotification(n, tFor("en"), LOCALE.en).title).toBe("Concentrated portfolio");
  });
});
