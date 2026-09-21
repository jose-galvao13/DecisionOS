import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";

// The server allows 30 requests/minute per IP; this file makes more than that
// on purpose, and rate limiting isn't what it is testing.
vi.mock("express-rate-limit", () => ({ default: () => (_req, _res, next) => next() }));

/* Real SQL, no mocks of the queries: the backend's pool is replaced by an
   in-memory PGlite Postgres loaded with the real schema.sql, so this
   exercises the actual active-source resolution, the scoped analytics
   query, the cascade on delete, the cache invalidation and the worker. */
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
import { getActiveDataSourceIds } from "../../src/services/activeSource.js";
import { putStaging } from "../../src/services/staging.js";
import { enqueueJob } from "../../src/services/jobQueue.js";
import { runOnce } from "../../src/worker.js";

const auth = (userId, orgId, role = "owner") => ({
  Authorization: `Bearer ${signToken({ sub: userId, orgId, role, email: `${userId}@x.test` })}`,
});

async function seedOrg(orgId, userId, role = "owner") {
  await pool.query(`INSERT INTO organizations (id, name) VALUES ($1, $2)`, [orgId, `Org ${orgId}`]);
  await pool.query(
    `INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,'x',$4,$5)`,
    [userId, orgId, `${userId}@x.test`, `User ${userId}`, role]
  );
}

/** A data source with `amounts.length` transactions, one per amount. `dates`
 *  (optional) sets each row's date; by default row i is on 2025-(i+1)-10. */
async function seedSource({ id, orgId, name, createdAt, status = "connected", amounts = [], dates = null, userId = null }) {
  await pool.query(
    `INSERT INTO data_sources (id, org_id, name, type, status, column_mapping, row_count, created_by, created_at)
     VALUES ($1,$2,$3,'excel',$4,'{}'::jsonb,$5,$6,$7)`,
    [id, orgId, name, status, amounts.length, userId, createdAt]
  );
  let i = 0;
  for (const amount of amounts) {
    await pool.query(
      `INSERT INTO transactions (id, org_id, data_source_id, date, quantity, gross_revenue, net_revenue, cost, gross_profit)
       VALUES ($1,$2,$3,$4,1,$5,$5,0,$5)`,
      [`${id}-tx${i}`, orgId, id, dates ? dates[i] : `2025-0${(i % 9) + 1}-10`, amount]
    );
    i++;
  }
}


const totalRevenue = async (headers) => {
  const res = await request(app).get("/api/analytics/full").set(headers);
  return { status: res.status, revenue: res.body?.totals?.revenue, count: res.body?.count, body: res.body };
};

const A = "ds-a"; // older file:  2 rows, 100 + 200      = 300  (2025-01-10, 2025-02-10)
const B = "ds-b"; // newer file:  3 rows, 10 + 20 + 30   = 60   (2025-01-10, 2025-02-10, 2025-03-10)

let headers;
let n = 0;
let orgId;
let userId;

beforeEach(async () => {
  n++;
  orgId = `org-${n}`;
  userId = `user-${n}`;
  await seedOrg(orgId, userId);
  headers = auth(userId, orgId);
});

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
});

async function seedTwoFiles() {
  const a = `${A}-${n}`;
  const b = `${B}-${n}`;
  await seedSource({ id: a, orgId, name: "vendas-2024.xlsx", createdAt: "2026-01-01T10:00:00Z", amounts: [100, 200], userId });
  await seedSource({ id: b, orgId, name: "vendas-2025.xlsx", createdAt: "2026-02-01T10:00:00Z", amounts: [10, 20, 30], userId });
  return { a, b };
}

const toggle = (id, query = "") => request(app).post(`/api/datasources/${id}/activate${query}`).set(headers);
const includedIds = async () => (await getActiveDataSourceIds(orgId)).sort();
const flagsOf = async () => Object.fromEntries((await pool.query(`SELECT id, is_active FROM data_sources WHERE org_id = $1`, [orgId])).rows.map((r) => [r.id, r.is_active]));

describe("several files included in the analysis at once", () => {
  it("lists every file; with nothing flagged the newest healthy one counts by default", async () => {
    const { a, b } = await seedTwoFiles();
    await seedSource({ id: `bad-${n}`, orgId, name: "falhou.xlsx", createdAt: "2026-03-01T10:00:00Z", status: "error", amounts: [] });

    const res = await request(app).get("/api/datasources").set(headers);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const byId = Object.fromEntries(res.body.dataSources.map((d) => [d.id, d]));
    expect(byId[b].is_active).toBe(true); // newest with data — the failed import is newer but has no rows
    expect(byId[a].is_active).toBe(false);
    expect(byId[`bad-${n}`].is_active).toBe(false);
  });

  it("returns each file's latest quality score with the list, as a number", async () => {
    const { a, b } = await seedTwoFiles();
    const report = (id, score, at) =>
      pool.query(`INSERT INTO data_quality_reports (id, org_id, data_source_id, score, issues, created_at) VALUES ($1,$2,$3,$4,'[]'::jsonb,$5)`, [`${id}-${score}`, orgId, id, score, at]);
    await report(a, 71, "2026-01-02T10:00:00Z");
    await report(a, 87.5, "2026-01-03T10:00:00Z"); // the newer report wins
    // b has no report yet

    const res = await request(app).get("/api/datasources").set(headers);
    const byId = Object.fromEntries(res.body.dataSources.map((d) => [d.id, d]));
    expect(byId[a].quality_score).toBe(87.5); // NUMERIC arrives as a string from pg; the API hands back a number
    expect(byId[b].quality_score).toBeNull();
  });

  it("analytics count only the included files; turning one on adds it, turning it off removes it, and the numbers follow immediately", async () => {
    const { a, b } = await seedTwoFiles();

    // first call is cached for 60s — every toggle below must invalidate it
    expect(await totalRevenue(headers)).toMatchObject({ status: 200, revenue: 60, count: 3 });

    // ON: adds A next to B (B was only included by fallback — that choice is now made explicit)
    const on = await toggle(a);
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ dataSourceId: a, active: true });
    expect([...on.body.activeDataSourceIds].sort()).toEqual([a, b].sort());
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 360, count: 5 });
    expect(await flagsOf()).toEqual({ [a]: true, [b]: true });

    const list = await request(app).get("/api/datasources").set(headers);
    expect(list.body.dataSources.every((d) => d.is_active)).toBe(true);

    // OFF: B leaves, A stays
    const off = await toggle(b);
    expect(off.body).toEqual({ dataSourceId: b, active: false, activeDataSourceIds: [a] });
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });
    expect(await flagsOf()).toEqual({ [a]: true, [b]: false });

    // the last included file can't be switched off — the org would be analysing nothing
    const last = await toggle(a);
    expect(last.status).toBe(409);
    expect(last.body.error).toMatch(/at least one/i);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });

    // and B can come back
    await toggle(b);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 360, count: 5 });

    const audit = await pool.query(`SELECT action, count(*)::int AS n FROM audit_log WHERE org_id = $1 GROUP BY action`, [orgId]);
    expect(Object.fromEntries(audit.rows.map((r) => [r.action, r.n]))).toMatchObject({
      "data_source.activated": 2, "data_source.deactivated": 1,
    });
  });

  it("refuses to include a source with no imported data, an unknown one, or another org's", async () => {
    await seedTwoFiles();
    await seedSource({ id: `bad-${n}`, orgId, name: "falhou.xlsx", createdAt: "2026-03-01T10:00:00Z", status: "error", amounts: [] });
    await seedSource({ id: `syncing-${n}`, orgId, name: "a-importar.xlsx", createdAt: "2026-03-02T10:00:00Z", status: "syncing", amounts: [] });

    expect((await toggle(`bad-${n}`)).status).toBe(409);
    expect((await toggle(`syncing-${n}`)).status).toBe(409);
    expect((await toggle("nope")).status).toBe(404);

    // a source that belongs to a different organization is invisible (404, not 403)
    await seedOrg(`other-${n}`, `other-user-${n}`);
    await seedSource({ id: `foreign-${n}`, orgId: `other-${n}`, name: "alheio.xlsx", createdAt: "2026-01-01T10:00:00Z", amounts: [999] });
    expect((await toggle(`foreign-${n}`)).status).toBe(404);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 60 }); // nothing changed
  });

  it("only managers and above can include, exclude or remove files", async () => {
    const { a } = await seedTwoFiles();
    await pool.query(`INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,'x','Viewer','viewer')`, [`viewer-${n}`, orgId, `viewer-${n}@x.test`]);
    const viewer = auth(`viewer-${n}`, orgId, "viewer");

    expect((await request(app).get("/api/datasources").set(viewer)).status).toBe(200); // can look
    expect((await request(app).post(`/api/datasources/${a}/activate`).set(viewer)).status).toBe(403);
    expect((await request(app).delete(`/api/datasources/${a}`).set(viewer)).status).toBe(403);
  });

  it("an explicit choice survives a newer upload sitting in the list until that one finishes importing", async () => {
    const { a, b } = await seedTwoFiles();
    await toggle(a); // both included
    await toggle(b); // only A
    // a new import is queued: 'syncing' with no rows yet — must not steal the view
    await seedSource({ id: `new-${n}`, orgId, name: "novo.xlsx", createdAt: "2026-04-01T10:00:00Z", status: "syncing", amounts: [] });
    expect(await includedIds()).toEqual([a]);
  });
});

describe("duplicate protection when including a file", () => {
  // C repeats A's rows exactly: same dates, same amounts
  async function seedDuplicateOfA() {
    const a = `${A}-${n}`;
    const c = `dup-${n}`;
    await seedSource({ id: a, orgId, name: "vendas-2024.xlsx", createdAt: "2026-01-01T10:00:00Z", amounts: [100, 200], userId });
    await seedSource({ id: c, orgId, name: "vendas-2024 (copia).xlsx", createdAt: "2026-02-01T10:00:00Z", amounts: [100, 200], userId });
    return { a, c }; // c is newer, so it is the one included by default
  }

  it("asks for confirmation instead of silently double-counting revenue, and changes nothing meanwhile", async () => {
    const { a, c } = await seedDuplicateOfA();
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 }); // only C

    const res = await toggle(a);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("possible_duplicates");
    expect(res.body.overlaps).toEqual([
      expect.objectContaining({ dataSourceId: c, name: "vendas-2024 (copia).xlsx", duplicateRowCount: 2 }),
    ]);

    expect(await flagsOf()).toEqual({ [a]: false, [c]: false }); // nothing was persisted
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });
  });

  it("includes it anyway when the person confirms (query flag or body flag) — and the revenue is then counted twice on purpose", async () => {
    const { a, c } = await seedDuplicateOfA();
    const ok = await toggle(a, "?ignoreDuplicates=true");
    expect(ok.status).toBe(200);
    expect([...ok.body.activeDataSourceIds].sort()).toEqual([a, c].sort());
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 600, count: 4 });

    // same outcome through the request body
    await toggle(a); // off
    const viaBody = await request(app).post(`/api/datasources/${a}/activate`).set(headers).send({ ignoreDuplicates: true });
    expect(viaBody.status).toBe(200);
  });

  it("does not flag files that only share dates or only share amounts", async () => {
    const { a, b } = await seedTwoFiles(); // same dates, different amounts
    expect((await toggle(a)).status).toBe(200);

    // same amounts as A but a different year: date ranges don't even overlap
    const d = `d-${n}`;
    await seedSource({ id: d, orgId, name: "vendas-2023.xlsx", createdAt: "2026-05-01T10:00:00Z", amounts: [100, 200], dates: ["2023-01-10", "2023-02-10"] });
    expect((await toggle(d)).status).toBe(200);
    expect((await includedIds()).sort()).toEqual([a, b, d].sort());
  });
});

describe("removing files", () => {
  it("removing an included file deletes its data and keeps the others included", async () => {
    const { a, b } = await seedTwoFiles();
    await toggle(a); // A and B
    await totalRevenue(headers); // warm the cache with the combined numbers

    const del = await request(app).delete(`/api/datasources/${b}`).set(headers);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, activeDataSourceId: a, activeDataSourceIds: [a] });

    const left = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE data_source_id = $1`, [b]);
    expect(left.rows[0].n).toBe(0); // cascade
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });
  });

  it("removing the only included file falls back to the newest remaining one", async () => {
    const { a, b } = await seedTwoFiles();
    await toggle(a); // both
    await toggle(b); // only A
    const del = await request(app).delete(`/api/datasources/${a}`).set(headers);
    expect(del.body).toEqual({ deleted: true, activeDataSourceId: b, activeDataSourceIds: [b] });
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 60, count: 3 });
  });

  it("removing a file that isn't included leaves the included ones alone", async () => {
    const { a, b } = await seedTwoFiles();
    await toggle(a);
    await toggle(b); // only A included
    const del = await request(app).delete(`/api/datasources/${b}`).set(headers);
    expect(del.body).toEqual({ deleted: true, activeDataSourceId: a, activeDataSourceIds: [a] });
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });
  });

  it("removing the last file leaves the org with no data, and analytics say so", async () => {
    const { a, b } = await seedTwoFiles();
    await request(app).delete(`/api/datasources/${a}`).set(headers);
    const last = await request(app).delete(`/api/datasources/${b}`).set(headers);
    expect(last.body).toEqual({ deleted: true, activeDataSourceId: null, activeDataSourceIds: [] });
    const res = await request(app).get("/api/analytics/full").set(headers);
    expect(res.status).toBe(404);
    expect((await request(app).delete(`/api/datasources/${b}`).set(headers)).status).toBe(404);
  });
});

describe("upgrading a database that only knew a single active file", () => {
  // schema.sql runs on every start. Its backfill turns the old single
  // organizations.active_data_source_id into the new per-file flag, once.
  const backfill = readFileSync(new URL("../../src/db/schema.sql", import.meta.url), "utf8").match(/UPDATE data_sources d[\s\S]*?;/)[0];

  it("keeps showing exactly the file the org had chosen, and is safe to run again", async () => {
    const { a, b } = await seedTwoFiles();
    await pool.query(`UPDATE organizations SET active_data_source_id = $2 WHERE id = $1`, [orgId, a]);
    expect(await flagsOf()).toEqual({ [a]: false, [b]: false });

    await pool.query(backfill);
    expect(await flagsOf()).toEqual({ [a]: true, [b]: false });
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 }); // A, not "the newest" B

    await pool.query(backfill); // idempotent
    expect(await flagsOf()).toEqual({ [a]: true, [b]: false });
  });

  it("never overrides a choice made after the upgrade", async () => {
    const { a, b } = await seedTwoFiles();
    await pool.query(`UPDATE organizations SET active_data_source_id = $2 WHERE id = $1`, [orgId, a]);
    await pool.query(`UPDATE data_sources SET is_active = true WHERE id = $1`, [b]); // the person already picked B
    await pool.query(backfill);
    expect(await flagsOf()).toEqual({ [a]: false, [b]: true });
  });
});

describe("importing through the worker", () => {
  const mapping = { date: "Data", revenue: "Receita", cost: "Custo", product: "Produto", region: "Regiao" };
  const rowsFor = (values) => values.map((v, i) => ({ Data: `2025-03-0${i + 1}T00:00:00.000Z`, Receita: v, Custo: v / 2, Produto: "P", Regiao: "R" }));

  async function uploadFile(name, values) {
    const stagingId = putStaging({ orgId, headers: Object.values(mapping), rows: rowsFor(values) });
    const dataSourceId = `up-${n}-${name}`;
    await pool.query(
      `INSERT INTO data_sources (id, org_id, name, type, status, column_mapping, created_by) VALUES ($1,$2,$3,'excel','syncing',$4,$5)`,
      [dataSourceId, orgId, name, JSON.stringify(mapping), userId]
    );
    await enqueueJob({ orgId, dataSourceId, type: "import_excel", payload: { stagingId, mapping }, createdBy: userId });
    const job = await runOnce();
    const done = await pool.query(`SELECT status, result, error FROM jobs WHERE id = $1`, [job.id]);
    return { dataSourceId, job, result: done.rows[0].result, status: done.rows[0].status, error: done.rows[0].error };
  }

  it("the first file is included, and the next different file is added next to it", async () => {
    const first = await uploadFile("primeiro.xlsx", [100, 200]);
    expect(first.result).toMatchObject({ included: true, duplicateOverlaps: [] });
    expect(await includedIds()).toEqual([first.dataSourceId]);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });

    const second = await uploadFile("segundo.xlsx", [1, 2, 3]);
    expect(second.result).toMatchObject({ included: true, duplicateOverlaps: [] });
    expect(await includedIds()).toEqual([first.dataSourceId, second.dataSourceId].sort());
    // both files count — that is the point of including several
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 306, count: 5 });

    const list = await request(app).get("/api/datasources").set(headers);
    expect(list.body.total).toBe(2);
    expect(list.body.dataSources.every((d) => d.is_active)).toBe(true);
  });

  it("uploading the same file again keeps it but leaves it out, so nothing is counted twice", async () => {
    const first = await uploadFile("vendas.xlsx", [100, 200]);
    const again = await uploadFile("vendas (2).xlsx", [100, 200]);

    expect(again.status).toBe("completed");
    expect(again.result.included).toBe(false);
    expect(again.result.duplicateOverlaps).toEqual([expect.objectContaining({ dataSourceId: first.dataSourceId, name: "vendas.xlsx", duplicateRowCount: 2 })]);
    expect(await includedIds()).toEqual([first.dataSourceId]);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 }); // not 600

    const list = await request(app).get("/api/datasources").set(headers);
    const copy = list.body.dataSources.find((d) => d.id === again.dataSourceId);
    expect(copy).toMatchObject({ status: "connected", row_count: 2, is_active: false }); // kept, importable, just not counted
    expect(copy.quality_score).not.toBeNull();

    // the person can still include it on purpose — after being warned
    expect((await toggle(again.dataSourceId)).status).toBe(409);
    expect((await toggle(again.dataSourceId, "?ignoreDuplicates=true")).status).toBe(200);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 600, count: 4 });
  });

  it("a file that was only included by fallback (nothing flagged yet) stays included when another arrives", async () => {
    const a = `${A}-${n}`;
    await seedSource({ id: a, orgId, name: "antigo.xlsx", createdAt: "2026-01-01T10:00:00Z", amounts: [1000], dates: ["2024-06-10"] });
    expect(await flagsOf()).toEqual({ [a]: false }); // legacy org: only "the newest source" logic applies

    const fresh = await uploadFile("novo.xlsx", [5, 6]);
    expect(fresh.result.included).toBe(true);
    expect(await includedIds()).toEqual([a, fresh.dataSourceId].sort()); // old file was not silently dropped
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 1011, count: 3 });
  });

  it("…and stays included when the newcomer is a duplicate (the fallback must not flip to the newest file)", async () => {
    const first = await uploadFile("vendas.xlsx", [100, 200]);
    await pool.query(`UPDATE data_sources SET is_active = false WHERE id = $1`, [first.dataSourceId]); // back to a legacy, unflagged org
    const again = await uploadFile("vendas (2).xlsx", [100, 200]);
    expect(again.result.included).toBe(false);
    expect(await includedIds()).toEqual([first.dataSourceId]);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });
  });

  it("a failed import never changes what is included", async () => {
    const ok = await uploadFile("bom.xlsx", [100, 200]);
    // staging that no longer exists -> the job fails
    const dataSourceId = `broken-${n}`;
    await pool.query(
      `INSERT INTO data_sources (id, org_id, name, type, status, column_mapping, created_by) VALUES ($1,$2,'partido.xlsx','excel','syncing',$3,$4)`,
      [dataSourceId, orgId, JSON.stringify(mapping), userId]
    );
    await enqueueJob({ orgId, dataSourceId, type: "import_excel", payload: { stagingId: "gone", mapping }, createdBy: userId });
    await runOnce();

    expect(await includedIds()).toEqual([ok.dataSourceId]);
    const bad = await pool.query(`SELECT status FROM data_sources WHERE id = $1`, [dataSourceId]);
    expect(bad.rows[0].status).toBe("error");
  });
});

describe("organization name on the logged-in user", () => {
  it("register, login and /me all return the organization the person created", async () => {
    const reg = await request(app).post("/api/auth/register").send({
      orgName: "Acme Lda", name: "Maria Silva", email: `maria-${n}@acme.test`, password: "palavra-passe-1",
    });
    expect(reg.status).toBe(200);
    expect(reg.body.user).toMatchObject({ name: "Maria Silva", orgName: "Acme Lda", role: "owner" });

    const login = await request(app).post("/api/auth/login").send({ email: `maria-${n}@acme.test`, password: "palavra-passe-1" });
    expect(login.body.user.orgName).toBe("Acme Lda");

    const me = await request(app).get("/api/auth/me").set({ Authorization: `Bearer ${login.body.token}` });
    expect(me.body.user).toMatchObject({ name: "Maria Silva", orgName: "Acme Lda" });
  });

  it("two organizations get two different names", async () => {
    const mk = (org, email) => request(app).post("/api/auth/register").send({ orgName: org, name: "Ana", email, password: "palavra-passe-1" });
    const one = await mk("Alfa SA", `alfa-${n}@x.test`);
    const two = await mk("Beta Lda", `beta-${n}@x.test`);
    expect([one.body.user.orgName, two.body.user.orgName]).toEqual(["Alfa SA", "Beta Lda"]);
  });
});
