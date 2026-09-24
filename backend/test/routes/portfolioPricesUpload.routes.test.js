import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";
import * as XLSX from "xlsx";
import { parsePriceRows } from "../../src/services/securityPricesImport.js";

vi.mock("express-rate-limit", () => ({ default: () => (_req, _res, next) => next() }));
// Real SQL against in-memory PGlite loaded with the real schema.sql (same
// pattern as priceHistory.routes.test.js) — so this also exercises the real
// queries of services/portfolioData.js end to end.
vi.mock("../../src/db/pool.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFileSync } = await import("node:fs");
  const db = new PGlite();
  await db.exec(readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8"));
  const q = (text, params) => db.query(text, params);
  const withTransaction = async (fn) => {
    await db.query("BEGIN");
    try { const r = await fn({ query: q, release() {} }); await db.query("COMMIT"); return r; }
    catch (e) { await db.query("ROLLBACK"); throw e; }
  };
  return { pool: { query: q, connect: async () => ({ query: q, release() {} }) }, query: q, withTransaction };
});

import { pool } from "../../src/db/pool.js";
import { signToken } from "../../src/auth/jwt.js";
import { app } from "../../src/server.js";

const auth = (userId, orgId, role = "manager") => ({
  Authorization: `Bearer ${signToken({ sub: userId, orgId, role, email: `${userId}@x.test` })}`,
});
const sheet = (aoa) => XLSX.write(Object.assign(XLSX.utils.book_new(), { SheetNames: ["S"], Sheets: { S: XLSX.utils.aoa_to_sheet(aoa) } }), { type: "buffer", bookType: "xlsx" });

describe("parsePriceRows", () => {
  it("matches headers by name (any case/accents), parses numbers and dates, defaults the currency to the held one", () => {
    const r = parsePriceRows(
      [["SÍMBOLO", "Preço Atual", "Data"], ["asml.as", "700,5", "2026-09-24"], ["SAP.DE", 175, null]],
      { defaultCurrencyByTicker: { "ASML.AS": "EUR", "SAP.DE": "EUR" } }
    );
    expect(r.prices).toEqual([
      { ticker: "ASML.AS", preco: 700.5, moeda: "EUR", data: "2026-09-24" },
      { ticker: "SAP.DE", preco: 175, moeda: "EUR", data: null },
    ]);
    expect(r.skipped).toBe(0);
  });

  it("skips and reports bad rows by their spreadsheet row number, keeping the good ones", () => {
    const r = parsePriceRows([
      ["Ticker", "Preço", "Moeda"],
      ["AAA", 10, "EUR"],
      ["", 10, "EUR"],        // row 3: no ticker
      ["BBB", 0, "EUR"],      // row 4: price must be > 0
      ["CCC", 5, "EURO"],     // row 5: currency isn't 3 letters
      ["DDD", 5, null],       // row 6: no currency and not held
    ]);
    expect(r.prices.map((p) => p.ticker)).toEqual(["AAA"]);
    expect(r.issues).toEqual([
      { row: 3, reason: "missing_ticker" }, { row: 4, reason: "invalid_price" },
      { row: 5, reason: "invalid_currency" }, { row: 6, reason: "invalid_currency" },
    ]);
    expect(r.skipped).toBe(4);
  });

  it("the last row wins for the same ticker and day, so the upsert never sees a key twice", () => {
    const r = parsePriceRows([["Ticker", "Preco", "Moeda"], ["AAA", 1, "EUR"], ["aaa", 2, "EUR"]]);
    expect(r.prices).toEqual([{ ticker: "AAA", preco: 2, moeda: "EUR", data: null }]);
  });

  it("errors when there is no ticker/price column, or nothing at all", () => {
    expect(parsePriceRows([["Nome", "Quantidade"], ["x", 1]]).error).toMatch(/Ticker column and a Preço/);
    expect(parsePriceRows([]).error).toMatch(/empty/);
  });
});

describe("POST /api/portfolio/prices/upload (real SQL)", () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO organizations (id, name) VALUES ('org-1','Org 1'), ('org-2','Org 2')`);
    for (const [u, o, role] of [["m1", "org-1", "manager"], ["v1", "org-1", "viewer"], ["m2", "org-2", "manager"]]) {
      await pool.query(`INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,'x',$1,$4)`, [u, o, `${u}@x.test`, role]);
    }
    await pool.query(`INSERT INTO portfolio_imports (id, org_id, name, status, row_count) VALUES ('imp-1','org-1','carteira.xlsx','connected',3)`);
    const h = (id, t, q, avg, cur = "EUR") =>
      pool.query(`INSERT INTO holdings (id, import_id, org_id, ticker, nome, quantidade, preco_medio, moeda) VALUES ($1,'imp-1','org-1',$2,$2,$3,$4,$5)`, [id, t, q, avg, cur]);
    await h("h1", "AAA", 6, 100);
    await h("h2", "BBB", 3, 100);
    await h("h3", "CCC", 1, 100);
  });

  it("401s without a token and 403s for a viewer", async () => {
    const file = sheet([["Ticker", "Preço"], ["AAA", 1]]);
    expect((await request(app).post("/api/portfolio/prices/upload").attach("file", file, "p.xlsx")).status).toBe(401);
    expect((await request(app).post("/api/portfolio/prices/upload").set(auth("v1", "org-1", "viewer")).attach("file", file, "p.xlsx")).status).toBe(403);
  });

  it("400s without a file, on an unreadable file, and when nothing valid is in it", async () => {
    const a = auth("m1", "org-1");
    expect((await request(app).post("/api/portfolio/prices/upload").set(a)).status).toBe(400);
    const noCols = await request(app).post("/api/portfolio/prices/upload").set(a).attach("file", sheet([["Nome"], ["x"]]), "p.xlsx");
    expect(noCols.status).toBe(400);
    const none = await request(app).post("/api/portfolio/prices/upload").set(a).attach("file", sheet([["Ticker", "Preço", "Moeda"], ["AAA", -1, "EUR"]]), "p.xlsx");
    expect(none.status).toBe(400);
    expect(none.body.issues).toEqual([{ row: 2, reason: "invalid_price" }]);
  });

  it("saves every valid row in one go, reports the skipped ones, and tells which tickers aren't held", async () => {
    const file = sheet([
      ["Ticker", "Preço", "Moeda"],
      ["AAA", 100, null],   // currency comes from the holding
      ["BBB", 100, "EUR"],
      ["CCC", 100, "EUR"],
      ["ZZZ", 5, "EUR"],    // not held
      ["BAD", "abc", "EUR"],
    ]);
    const res = await request(app).post("/api/portfolio/prices/upload").set(auth("m1", "org-1")).attach("file", file, "precos.xlsx");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 4, skipped: 1, notHeld: ["ZZZ"], issues: [{ row: 6, reason: "invalid_price" }] });
    const { rows } = await pool.query(`SELECT ticker, preco, moeda, origem FROM security_prices WHERE org_id = 'org-1' ORDER BY ticker`);
    expect(rows.map((r) => [r.ticker, Number(r.preco), r.moeda, r.origem])).toEqual([
      ["AAA", 100, "EUR", "upload"], ["BBB", 100, "EUR", "upload"], ["CCC", 100, "EUR", "upload"], ["ZZZ", 5, "EUR", "upload"],
    ]);
  });

  it("re-uploading the same day corrects the price instead of adding rows", async () => {
    const res = await request(app).post("/api/portfolio/prices/upload").set(auth("m1", "org-1"))
      .attach("file", sheet([["Ticker", "Preço", "Moeda"], ["AAA", 100, "EUR"], ["ZZZ", 6, "EUR"]]), "precos.xlsx");
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT preco FROM security_prices WHERE org_id = 'org-1' AND ticker = 'ZZZ'`);
    expect(rows.map((r) => Number(r.preco))).toEqual([6]);
  });

  it("is per organisation: another org's holdings/prices are untouched", async () => {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM security_prices WHERE org_id = 'org-2'`);
    expect(rows[0].n).toBe(0);
  });

  it("then the portfolio is priced: weights 60/30/10 from GET /analytics", async () => {
    const res = await request(app).get("/api/portfolio/analytics").set(auth("m1", "org-1"));
    expect(res.status).toBe(200);
    const w = Object.fromEntries(res.body.positions.map((p) => [p.ticker, p.pesoPct]));
    expect(w).toEqual({ AAA: 60, BBB: 30, CCC: 10 });
    expect(res.body.concentration.hhi).toBeCloseTo(0.46, 4);
  });

  it("…and the Decision Simulator's sell_position works on it (real queries end to end)", async () => {
    const res = await request(app).post("/api/simulate").set(auth("m1", "org-1")).send({ type: "sell_position", ticker: "AAA", percent: 50 });
    expect(res.status).toBe(200);
    expect(res.body.current.hhi).toBeCloseTo(0.46, 4);
    expect(res.body.scenario.hhi).toBeCloseTo(0.3878, 4);
    expect(res.body.current.var95.insufficientData).toBe(true); // no price history uploaded
  });

  it("…and the concentration alert shows up in the bell", async () => {
    const res = await request(app).get("/api/notifications").set(auth("m1", "org-1"));
    expect(res.status).toBe(200);
    const n = res.body.notifications.find((x) => x.kind === "portfolio_concentration");
    expect(n).toMatchObject({ severity: "red", target: { view: "portfolio" }, params: { ticker: "AAA", pesoPct: 60 } });
  });

  it("…and the advisor's portfolio tools read it (get_portfolio_summary)", async () => {
    const { loadPortfolioContext } = await import("../../src/services/portfolioData.js");
    const { runTool } = await import("../../src/analytics-tools.js");
    const portfolio = await loadPortfolioContext("org-1");
    const r = runTool("get_portfolio_summary", {}, { analytics: null, portfolio });
    expect(r.totals.value).toBe(1000);
    expect(r.concentration.top3[0]).toMatchObject({ ticker: "AAA", pesoPct: 60 });
  });
});
