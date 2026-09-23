import { describe, it, expect, vi, beforeAll } from "vitest";
import request from "supertest";

// Same convention as the other routes.test.js files: rate limiting isn't
// what this file is testing.
vi.mock("express-rate-limit", () => ({ default: () => (_req, _res, next) => next() }));

// Real SQL against an in-memory PGlite Postgres loaded with the real
// schema.sql — same pattern as activeDataSource.routes.test.js.
vi.mock("../../src/db/pool.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { readFileSync } = await import("node:fs");
  const db = new PGlite();
  await db.exec(readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8"));
  const q = (text, params) => db.query(text, params);
  const withTransaction = async (fn) => {
    await db.query("BEGIN");
    try {
      const r = await fn({ query: q, release() {} });
      await db.query("COMMIT");
      return r;
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    }
  };
  return {
    pool: { query: q, connect: async () => ({ query: q, release() {} }) },
    query: q,
    withTransaction,
  };
});

import { pool } from "../../src/db/pool.js";
import { signToken } from "../../src/auth/jwt.js";
import { app } from "../../src/server.js";
import { putStaging } from "../../src/services/staging.js";
import { runOnce } from "../../src/worker.js";
import { MIN_OBSERVATIONS } from "../../src/services/riskAnalytics.js";

const auth = (userId, orgId, role = "manager") => ({
  Authorization: `Bearer ${signToken({ sub: userId, orgId, role, email: `${userId}@x.test` })}`,
});

async function seedOrg(orgId, userId, role = "manager") {
  await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [orgId, `Org ${orgId}`]);
  await pool.query(
    `INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,'x',$4,$5)`,
    [userId, orgId, `${userId}@x.test`, `User ${userId}`, role]
  );
}

/** n days of (date, close) rows, starting at `start`, as the raw-row shape
 *  a staged Excel upload would produce (header names, not `date`/`fecho`). */
function rawRows(ticker, n, { start = 100, dateFrom = "2024-01-01", wobble = 0.01 } = {}) {
  const rows = [];
  let price = start;
  let d = new Date(dateFrom);
  for (let i = 0; i < n; i++) {
    rows.push({ Ticker: ticker, Data: d.toISOString().slice(0, 10), Fecho: Number(price.toFixed(4)) });
    price = price * (1 + Math.sin(i / 3) * wobble);
    d.setDate(d.getDate() + 1);
  }
  return rows;
}

const MAPPING = { ticker: "Ticker", date: "Data", close_price: "Fecho" };

describe("POST /api/portfolio/price-history/commit + GET /api/portfolio/risk", () => {
  let orgId, userId;
  beforeAll(async () => {
    orgId = "org-risk-1";
    userId = "user-risk-1";
    await seedOrg(orgId, userId);
  });

  it("imports a staged upload through the worker and computes risk metrics from it", async () => {
    const rows = [...rawRows("AAA", MIN_OBSERVATIONS + 5)];
    const stagingId = putStaging({ orgId, headers: ["Ticker", "Data", "Fecho"], rows });

    const commitRes = await request(app)
      .post("/api/portfolio/price-history/commit")
      .set(auth(userId, orgId))
      .send({ stagingId, mapping: MAPPING });
    expect(commitRes.status).toBe(202);
    expect(commitRes.body.jobId).toBeTruthy();

    const job = await runOnce();
    const done = await pool.query(`SELECT status, result FROM jobs WHERE id = $1`, [job.id]);
    expect(done.rows[0].status).toBe("completed");
    expect(done.rows[0].result.imported).toBe(rows.length);
    expect(done.rows[0].result.tickers).toEqual(["AAA"]);

    const riskRes = await request(app).get("/api/portfolio/risk").set(auth(userId, orgId));
    expect(riskRes.status).toBe(200);
    expect(riskRes.body.tickers).toContain("AAA");
    const aaa = riskRes.body.perTicker.AAA;
    expect(aaa.observations).toBeGreaterThanOrEqual(MIN_OBSERVATIONS);
    expect(aaa.insufficientData).toBe(false);
    expect(aaa.volatilidadeAnualizada).not.toBeNull();
    expect(aaa.var95Pct).not.toBeNull();
    expect(Array.isArray(aaa.drawdownCurve)).toBe(true);
  });

  it("flags a ticker with fewer than MIN_OBSERVATIONS rows as insufficient data", async () => {
    const rows = rawRows("BBB", 10, { dateFrom: "2024-06-01" });
    const stagingId = putStaging({ orgId, headers: ["Ticker", "Data", "Fecho"], rows });
    await request(app).post("/api/portfolio/price-history/commit").set(auth(userId, orgId)).send({ stagingId, mapping: MAPPING });
    await runOnce();

    const riskRes = await request(app).get("/api/portfolio/risk?tickers=BBB").set(auth(userId, orgId));
    expect(riskRes.status).toBe(200);
    expect(riskRes.body.perTicker.BBB.insufficientData).toBe(true);
    expect(riskRes.body.perTicker.BBB.volatilidadeAnualizada).toBeNull();
  });

  it("computes beta against an explicit index ticker", async () => {
    const idxRows = rawRows("IDX", MIN_OBSERVATIONS + 5, { dateFrom: "2025-01-01", start: 4000, wobble: 0.005 });
    const stagingId = putStaging({ orgId, headers: ["Ticker", "Data", "Fecho"], rows: idxRows });
    await request(app).post("/api/portfolio/price-history/commit").set(auth(userId, orgId)).send({ stagingId, mapping: MAPPING });
    await runOnce();

    const ccRows = rawRows("CCC", MIN_OBSERVATIONS + 5, { dateFrom: "2025-01-01", start: 50, wobble: 0.005 });
    const stagingId2 = putStaging({ orgId, headers: ["Ticker", "Data", "Fecho"], rows: ccRows });
    await request(app).post("/api/portfolio/price-history/commit").set(auth(userId, orgId)).send({ stagingId: stagingId2, mapping: MAPPING });
    await runOnce();

    const riskRes = await request(app).get("/api/portfolio/risk?tickers=CCC,IDX&index=IDX").set(auth(userId, orgId));
    expect(riskRes.status).toBe(200);
    expect(riskRes.body.perTicker.IDX.beta).toBeNull(); // never beta'd against itself
    expect(riskRes.body.perTicker.CCC.beta).not.toBeNull();
    expect(riskRes.body.correlationMatrix.CCC.IDX).not.toBeNull();
  });

  it("rejects an incomplete mapping on commit", async () => {
    const stagingId = putStaging({ orgId, headers: ["Ticker", "Data"], rows: [{ Ticker: "ZZZ", Data: "2024-01-01" }] });
    const res = await request(app)
      .post("/api/portfolio/price-history/commit")
      .set(auth(userId, orgId))
      .send({ stagingId, mapping: { ticker: "Ticker", date: "Data" } }); // missing close_price
    expect(res.status).toBe(400);
  });

  it("a viewer cannot commit an import (requires manager+)", async () => {
    const stagingId = putStaging({ orgId, headers: ["Ticker", "Data", "Fecho"], rows: rawRows("DDD", 5) });
    const res = await request(app)
      .post("/api/portfolio/price-history/commit")
      .set(auth(userId, orgId, "viewer"))
      .send({ stagingId, mapping: MAPPING });
    expect(res.status).toBe(403);
  });

  it("DELETE removes a ticker's history and the next risk read no longer includes it", async () => {
    const rows = rawRows("EEE", MIN_OBSERVATIONS + 2, { dateFrom: "2023-01-01" });
    const stagingId = putStaging({ orgId, headers: ["Ticker", "Data", "Fecho"], rows });
    await request(app).post("/api/portfolio/price-history/commit").set(auth(userId, orgId)).send({ stagingId, mapping: MAPPING });
    await runOnce();

    const del = await request(app).delete("/api/portfolio/price-history/EEE").set(auth(userId, orgId));
    expect(del.status).toBe(200);
    expect(del.body.rows).toBe(rows.length);

    const riskRes = await request(app).get("/api/portfolio/risk?tickers=EEE").set(auth(userId, orgId));
    expect(riskRes.body.perTicker.EEE.observations).toBe(0);
  });
});
