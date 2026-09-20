import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
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
import { getActiveDataSourceId } from "../../src/services/activeSource.js";
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

/** A data source with `amounts.length` transactions, one per amount. */
async function seedSource({ id, orgId, name, createdAt, status = "connected", amounts = [], userId = null }) {
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
      [`${id}-tx${i}`, orgId, id, `2025-0${(i % 9) + 1}-10`, amount]
    );
    i++;
  }
}

const totalRevenue = async (headers) => {
  const res = await request(app).get("/api/analytics/full").set(headers);
  return { status: res.status, revenue: res.body?.totals?.revenue, count: res.body?.count, body: res.body };
};

const A = "ds-a"; // older file: 2 rows, 100 + 200 = 300
const B = "ds-b"; // newer file: 3 rows, 10 + 20 + 30 = 60

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

const idsFor = (base) => ({ a: `${A}-${base}`, b: `${B}-${base}` });

async function seedTwoFiles() {
  const { a, b } = idsFor(n);
  await seedSource({ id: a, orgId, name: "vendas-2024.xlsx", createdAt: "2026-01-01T10:00:00Z", amounts: [100, 200], userId });
  await seedSource({ id: b, orgId, name: "vendas-2025.xlsx", createdAt: "2026-02-01T10:00:00Z", amounts: [10, 20, 30], userId });
  return { a, b };
}

describe("several files per organization", () => {
  it("lists every file and marks the newest healthy one as active by default", async () => {
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

  it("analytics only count the active file, and switching files changes every number immediately", async () => {
    const { a, b } = await seedTwoFiles();

    // first call is cached for 60s — the switch below must invalidate it
    expect(await totalRevenue(headers)).toMatchObject({ status: 200, revenue: 60, count: 3 });

    const act = await request(app).post(`/api/datasources/${a}/activate`).set(headers);
    expect(act.status).toBe(200);
    expect(act.body).toEqual({ dataSourceId: a, active: true });
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });

    const list = await request(app).get("/api/datasources").set(headers);
    expect(list.body.dataSources.find((d) => d.id === a).is_active).toBe(true);
    expect(list.body.dataSources.find((d) => d.id === b).is_active).toBe(false);

    // and back again
    await request(app).post(`/api/datasources/${b}/activate`).set(headers);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 60, count: 3 });

    // the switch is recorded in the audit log
    const audit = await pool.query(`SELECT action FROM audit_log WHERE org_id = $1 AND action = 'data_source.activated'`, [orgId]);
    expect(audit.rows).toHaveLength(2);
  });

  it("refuses to activate a source with no imported data, an unknown one, or another org's", async () => {
    await seedTwoFiles();
    await seedSource({ id: `bad-${n}`, orgId, name: "falhou.xlsx", createdAt: "2026-03-01T10:00:00Z", status: "error", amounts: [] });
    await seedSource({ id: `syncing-${n}`, orgId, name: "a-importar.xlsx", createdAt: "2026-03-02T10:00:00Z", status: "syncing", amounts: [] });

    expect((await request(app).post(`/api/datasources/bad-${n}/activate`).set(headers)).status).toBe(409);
    expect((await request(app).post(`/api/datasources/syncing-${n}/activate`).set(headers)).status).toBe(409);
    expect((await request(app).post(`/api/datasources/nope/activate`).set(headers)).status).toBe(404);

    // a source that belongs to a different organization is invisible (404, not 403)
    await seedOrg(`other-${n}`, `other-user-${n}`);
    await seedSource({ id: `foreign-${n}`, orgId: `other-${n}`, name: "alheio.xlsx", createdAt: "2026-01-01T10:00:00Z", amounts: [999] });
    expect((await request(app).post(`/api/datasources/foreign-${n}/activate`).set(headers)).status).toBe(404);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 60 }); // nothing changed
  });

  it("only managers and above can switch or remove files", async () => {
    const { a } = await seedTwoFiles();
    await pool.query(`INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,'x','Viewer','viewer')`, [`viewer-${n}`, orgId, `viewer-${n}@x.test`]);
    const viewer = auth(`viewer-${n}`, orgId, "viewer");

    expect((await request(app).get("/api/datasources").set(viewer)).status).toBe(200); // can look
    expect((await request(app).post(`/api/datasources/${a}/activate`).set(viewer)).status).toBe(403);
    expect((await request(app).delete(`/api/datasources/${a}`).set(viewer)).status).toBe(403);
  });

  it("removing the active file deletes its data and falls back to the next one", async () => {
    const { a, b } = await seedTwoFiles();
    expect(await getActiveDataSourceId(orgId)).toBe(b);
    await totalRevenue(headers); // warm the cache with B's numbers

    const del = await request(app).delete(`/api/datasources/${b}`).set(headers);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, activeDataSourceId: a });

    const left = await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE data_source_id = $1`, [b]);
    expect(left.rows[0].n).toBe(0); // cascade
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });

    // removing a file that is NOT active leaves the active one alone
    await seedSource({ id: `extra-${n}`, orgId, name: "extra.xlsx", createdAt: "2025-12-01T10:00:00Z", amounts: [5] });
    const del2 = await request(app).delete(`/api/datasources/extra-${n}`).set(headers);
    expect(del2.body).toEqual({ deleted: true, activeDataSourceId: a });
  });

  it("an explicit choice survives a newer upload sitting in the list until that one finishes importing", async () => {
    const { a } = await seedTwoFiles();
    await request(app).post(`/api/datasources/${a}/activate`).set(headers);
    // a new import is queued: 'syncing' with no rows yet — must not steal the view
    await seedSource({ id: `new-${n}`, orgId, name: "novo.xlsx", createdAt: "2026-04-01T10:00:00Z", status: "syncing", amounts: [] });
    expect(await getActiveDataSourceId(orgId)).toBe(a);
  });

  it("removing the last file leaves the org with no data, and analytics say so", async () => {
    const { a, b } = await seedTwoFiles();
    await request(app).delete(`/api/datasources/${a}`).set(headers);
    const last = await request(app).delete(`/api/datasources/${b}`).set(headers);
    expect(last.body).toEqual({ deleted: true, activeDataSourceId: null });
    const res = await request(app).get("/api/analytics/full").set(headers);
    expect(res.status).toBe(404);
    expect((await request(app).delete(`/api/datasources/${b}`).set(headers)).status).toBe(404);
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
    return { dataSourceId, job };
  }

  it("a freshly imported file becomes the active one while the old file is kept", async () => {
    const first = await uploadFile("primeiro.xlsx", [100, 200]);
    expect(await getActiveDataSourceId(orgId)).toBe(first.dataSourceId);
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 300, count: 2 });

    const second = await uploadFile("segundo.xlsx", [1, 2, 3]);
    expect(await getActiveDataSourceId(orgId)).toBe(second.dataSourceId);
    // only the new file is analysed — before this change both files were summed (306)
    expect(await totalRevenue(headers)).toMatchObject({ revenue: 6, count: 3 });

    const list = await request(app).get("/api/datasources").set(headers);
    expect(list.body.total).toBe(2);
    expect(list.body.dataSources.map((d) => d.is_active)).toEqual([true, false]); // newest first
  });

  it("a failed import never steals the view", async () => {
    const ok = await uploadFile("bom.xlsx", [100, 200]);
    // staging that no longer exists -> the job fails
    const dataSourceId = `broken-${n}`;
    await pool.query(
      `INSERT INTO data_sources (id, org_id, name, type, status, column_mapping, created_by) VALUES ($1,$2,'partido.xlsx','excel','syncing',$3,$4)`,
      [dataSourceId, orgId, JSON.stringify(mapping), userId]
    );
    await enqueueJob({ orgId, dataSourceId, type: "import_excel", payload: { stagingId: "gone", mapping }, createdBy: userId });
    await runOnce();

    expect(await getActiveDataSourceId(orgId)).toBe(ok.dataSourceId);
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
