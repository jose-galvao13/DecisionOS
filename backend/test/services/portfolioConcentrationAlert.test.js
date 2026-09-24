import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildPortfolioAnalytics } from "../../src/services/portfolioAnalytics.js";
import { buildRateIndex } from "../../src/services/fxRates.js";

// Parte 2, FASE 4 — the "concentração" notification. Only the portfolio
// source is exercised here; the bell's other sources are mocked to empty.
const queryMock = vi.fn();
vi.mock("../../src/db/pool.js", () => ({ pool: { query: (...a) => queryMock(...a) } }));
vi.mock("../../src/services/analyticsEngine.js", () => ({ computeAnalyticsForOrg: async () => null }));
vi.mock("../../src/services/decisionEngine.js", () => ({ generateDecisions: () => [] }));
vi.mock("../../src/services/activeSource.js", () => ({ getActiveDataSourceIds: async () => [] }));
const portfolioMock = vi.fn();
vi.mock("../../src/services/portfolioData.js", () => ({ loadPortfolioAnalytics: (...a) => portfolioMock(...a) }));

import { buildNotifications } from "../../src/services/notifications.js";

const asViewer = { id: "v1", orgId: "org-A", role: "viewer" };
const asManager = { id: "m1", orgId: "org-A", role: "manager" };

// A portfolio whose EUR values are exactly `values` (quantity 1 at that price).
const analyticsOf = (values, extra = []) =>
  buildPortfolioAnalytics(
    [...Object.entries(values).map(([ticker, v]) => ({ ticker, nome: `${ticker} Inc`, sector: null, pais: null, tipoAtivo: null, quantidade: 1, precoMedio: 1, precoAtual: v, moeda: "EUR" })), ...extra],
    { defaultCurrency: "EUR", rateIndex: buildRateIndex([]) }
  );
const concentration = async (user = asViewer) => (await buildNotifications(user)).notifications.filter((n) => n.kind === "portfolio_concentration");

beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
  portfolioMock.mockReset();
  portfolioMock.mockResolvedValue(analyticsOf({}));
});

describe("portfolio concentration notification", () => {
  it("fires when one position is above 25% and points at the portfolio view", async () => {
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 40, BBB: 35, CCC: 25 }));
    const [n] = await concentration();
    expect(n).toMatchObject({
      kind: "portfolio_concentration", severity: "yellow", read: false,
      key: "portfolio_concentration:AAA:40", target: { view: "portfolio" },
    });
    // HHI = .40^2 + .35^2 + .25^2 = 0.345 -> 1/0.345 = 2.9 effective positions
    expect(n.params).toMatchObject({ ticker: "AAA", nome: "AAA Inc", pesoPct: 40, hhi: 0.345, effectiveN: 2.9, positions: 3, reasons: ["position", "hhi"], maxPositionPct: 25, hhiLimit: 0.2 });
  });

  it("is red when the top position is half of the portfolio or more", async () => {
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 50, BBB: 30, CCC: 20 }));
    expect((await concentration())[0].severity).toBe("red");
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 49, BBB: 31, CCC: 20 }));
    expect((await concentration())[0].severity).toBe("yellow");
  });

  it("stays quiet for a diversified portfolio (10 equal positions: 10% each, HHI 0.10)", async () => {
    portfolioMock.mockResolvedValue(analyticsOf(Object.fromEntries("ABCDEFGHIJ".split("").map((t) => [t, 100]))));
    expect(await concentration()).toEqual([]);
  });

  it("fires on HHI alone: 4 x 24% + 4% has no position above 25% but an HHI of 0.2320", async () => {
    portfolioMock.mockResolvedValue(analyticsOf({ A: 24, B: 24, C: 24, D: 24, E: 4 }));
    const [n] = await concentration();
    expect(n.params.reasons).toEqual(["hhi"]);
    expect(n.params.pesoPct).toBe(24);
    expect(n.params.hhi).toBe(0.232);
  });

  it("the thresholds are 'above': a top position of exactly 25% only counts through the HHI", async () => {
    portfolioMock.mockResolvedValue(analyticsOf({ A: 25, B: 25, C: 25, D: 25 })); // HHI 0.25 > 0.20
    expect((await concentration())[0].params.reasons).toEqual(["hhi"]);
    portfolioMock.mockResolvedValue(analyticsOf({ A: 25, B: 15, C: 15, D: 15, E: 15, F: 15 })); // top exactly 25, HHI 0.1375
    expect(await concentration()).toEqual([]);
  });

  it("ignores positions with no price: they are outside the weights and can neither trigger nor hide it", async () => {
    const unpriced = { ticker: "NOP", nome: null, sector: null, pais: null, tipoAtivo: null, quantidade: 1000, precoMedio: 1, precoAtual: null, moeda: "EUR" };
    portfolioMock.mockResolvedValue(analyticsOf({ A: 10, B: 10, C: 10, D: 10, E: 10, F: 10, G: 10, H: 10, I: 10, J: 10 }, [unpriced]));
    expect(await concentration()).toEqual([]);
    portfolioMock.mockResolvedValue(buildPortfolioAnalytics([unpriced], { defaultCurrency: "EUR", rateIndex: buildRateIndex([]) }));
    expect(await concentration()).toEqual([]);
  });

  it("no portfolio, no notification", async () => {
    expect(await concentration()).toEqual([]);
  });

  it("the key follows the composition in 5-point steps, so small market moves don't re-notify", async () => {
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 61, BBB: 39 }));
    const a = (await concentration())[0].key;
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 63, BBB: 37 }));
    expect((await concentration())[0].key).toBe(a);
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 66, BBB: 34 }));
    expect((await concentration())[0].key).not.toBe(a);
    portfolioMock.mockResolvedValue(analyticsOf({ ZZZ: 61, BBB: 39 }));
    expect((await concentration())[0].key).not.toBe(a);
  });

  it("is for everyone, not only managers", async () => {
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 70, BBB: 30 }));
    expect(await concentration(asViewer)).toHaveLength(1);
    expect(await concentration(asManager)).toHaveLength(1);
  });

  it("marks it read once this person has read it", async () => {
    portfolioMock.mockResolvedValue(analyticsOf({ AAA: 70, BBB: 30 }));
    queryMock.mockImplementation(async (sql) => (/FROM notification_reads/.test(sql) ? { rows: [{ key: "portfolio_concentration:AAA:70" }] } : { rows: [] }));
    const r = await buildNotifications(asViewer);
    expect(r.notifications[0]).toMatchObject({ kind: "portfolio_concentration", read: true });
    expect(r.unreadCount).toBe(0);
  });

  it("a failure loading the portfolio never takes the bell down", async () => {
    portfolioMock.mockRejectedValue(new Error("boom"));
    const r = await buildNotifications(asViewer);
    expect(r.notifications).toEqual([]);
  });
});
