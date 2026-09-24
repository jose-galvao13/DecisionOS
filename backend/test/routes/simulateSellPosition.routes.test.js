import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { signToken } from "../../src/auth/jwt.js";
import { buildPortfolioAnalytics } from "../../src/services/portfolioAnalytics.js";
import { buildRateIndex } from "../../src/services/fxRates.js";

// POST /api/simulate, type 'sell_position' (Parte 2, FASE 4). The route only
// wires the portfolio loader to simulateSellPosition (covered by its own
// unit tests), so the loader is mocked and so is the sales analytics — the
// point is that a portfolio what-if never needs transactions.
const analyticsMock = vi.fn();
vi.mock("../../src/services/analyticsEngine.js", () => ({ computeAnalyticsForOrg: (...a) => analyticsMock(...a) }));
const contextMock = vi.fn();
vi.mock("../../src/services/portfolioData.js", () => ({ loadPortfolioContext: (...a) => contextMock(...a) }));

import simulationRouter from "../../src/routes/simulation.routes.js";

const app = express();
app.use(express.json());
app.use("/api/simulate", simulationRouter);
const token = signToken({ sub: "user-A", orgId: "org-A", role: "viewer", email: "a@a.com" });
const post = (body) => request(app).post("/api/simulate").set("Authorization", `Bearer ${token}`).send(body);

const raw = (ticker, quantidade, precoAtual) => ({ ticker, nome: null, sector: null, pais: null, tipoAtivo: null, quantidade, precoMedio: 1, precoAtual, moeda: "EUR" });
const portfolio = (positions) => ({
  analytics: buildPortfolioAnalytics(positions, { defaultCurrency: "EUR", rateIndex: buildRateIndex([]) }),
  seriesByTicker: {},
});

beforeEach(() => {
  analyticsMock.mockReset();
  contextMock.mockReset();
});

describe("POST /api/simulate — type 'sell_position'", () => {
  it("401s without a token", async () => {
    const res = await request(app).post("/api/simulate").send({ type: "sell_position", ticker: "AAA", percent: 10 });
    expect(res.status).toBe(401);
  });

  it("lists sell_position among the valid types", async () => {
    const res = await post({ type: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sell_position/);
  });

  it("runs the simulation on the org's portfolio without touching the sales analytics", async () => {
    contextMock.mockResolvedValueOnce(portfolio([raw("AAA", 6, 100), raw("BBB", 4, 100)]));
    const res = await post({ type: "sell_position", ticker: "AAA", percent: 50 });
    expect(res.status).toBe(200);
    expect(contextMock).toHaveBeenCalledWith("org-A");
    expect(analyticsMock).not.toHaveBeenCalled();
    expect(res.body.ticker).toBe("AAA");
    expect(res.body.current.hhi).toBeCloseTo(0.52, 4);      // .6^2 + .4^2
    expect(res.body.scenario.hhi).toBeCloseTo(0.5102, 4);   // (300/700)^2 + (400/700)^2
    expect(res.body.disclaimer).toMatch(/not financial advice/i);
  });

  it("400s without a ticker", async () => {
    const res = await post({ type: "sell_position", percent: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/ticker is required/);
    expect(contextMock).not.toHaveBeenCalled();
  });

  it("404s when the org has no portfolio yet", async () => {
    contextMock.mockResolvedValueOnce(portfolio([]));
    const res = await post({ type: "sell_position", ticker: "AAA", percent: 10 });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/import a holdings file/);
  });

  it("400s with the engine's message for a bad percent or an unknown ticker", async () => {
    contextMock.mockResolvedValue(portfolio([raw("AAA", 6, 100)]));
    const bad = await post({ type: "sell_position", ticker: "AAA", percent: 150 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/percent/);
    const unknown = await post({ type: "sell_position", ticker: "ZZZ", percent: 10 });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/unknown ticker/);
  });
});
