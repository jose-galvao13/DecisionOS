import pg from "pg";
import { resolveSafeHost, assertValidPort } from "../utils/ssrfGuard.js";

const { Client } = pg;

/** config: { host, port, database, user, password, ssl } — the customer's
 *  OWN PostgreSQL, not ours. Every function opens a short-lived client and
 *  always closes it, since these are ad-hoc admin operations (test/browse),
 *  not the app's steady-state pool.
 *
 *  SSRF guard (roadmap FASE 2): config.host is attacker-controlled input —
 *  it comes straight from the request body of an authenticated admin, who
 *  could otherwise point this at 169.254.169.254, an internal service, or
 *  localhost. resolveSafeHost() resolves it ourselves, rejects anything
 *  loopback/private/link-local/metadata, and returns the validated IP,
 *  which is what we actually connect to (see ssrfGuard.js for why this
 *  also closes the DNS-rebinding gap a naive re-check wouldn't). */
async function withClient(config, fn) {
  const safeHost = await resolveSafeHost(config.host);
  const port = assertValidPort(config.port || 5432);
  const client = new Client({
    host: safeHost,
    port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 8000,
    statement_timeout: 15000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function testConnection(config) {
  await withClient(config, (client) => client.query("SELECT 1"));
  return { ok: true };
}

export async function listSchemas(config) {
  return withClient(config, async (client) => {
    const { rows } = await client.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
       ORDER BY schema_name`
    );
    return rows.map((r) => r.schema_name);
  });
}

export async function listTables(config, schema) {
  return withClient(config, async (client) => {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema]
    );
    return rows.map((r) => r.table_name);
  });
}

/** Validates schema/table exist (via information_schema, never string-built
 *  into a query directly) before letting them be interpolated as quoted
 *  identifiers — this is what makes it safe to use them in a SELECT below,
 *  since parameterized queries can't parameterize identifiers. */
async function assertRealTable(client, schema, table) {
  const { rows } = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [schema, table]
  );
  if (!rows.length) throw new Error(`unknown table ${schema}.${table}`);
}

function qident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export async function previewTable(config, schema, table, limit = 20) {
  return withClient(config, async (client) => {
    await assertRealTable(client, schema, table);
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
      [schema, table]
    );
    const headers = cols.rows.map((r) => r.column_name);
    const { rows } = await client.query(
      `SELECT * FROM ${qident(schema)}.${qident(table)} LIMIT $1`,
      [Math.min(limit, 100)]
    );
    return { headers, rows };
  });
}

/** Pulls the full table (capped) for commit/refresh. A hard cap keeps a
 *  fat-fingered "commit" from trying to stream millions of rows through a
 *  single request — real large-table sync is a job queue, future work. */
export async function fetchAllRows(config, schema, table, cap = 100_000) {
  return withClient(config, async (client) => {
    await assertRealTable(client, schema, table);
    const { rows } = await client.query(`SELECT * FROM ${qident(schema)}.${qident(table)} LIMIT $1`, [cap]);
    return rows;
  });
}
