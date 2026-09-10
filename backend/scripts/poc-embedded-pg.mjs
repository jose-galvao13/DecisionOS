import { startEmbeddedPostgres } from "../src/desktop/embeddedPostgres.js";
import pg from "pg";

const dataDir = "/tmp/decisionos-embedded-pg-poc";

const embedded = await startEmbeddedPostgres(dataDir);
console.log("Embedded Postgres listening on port", embedded.port);

process.env.DATABASE_URL = embedded.connectionString;

// Import migrate.js AFTER setting DATABASE_URL, since pool.js reads it at
// module-load time — exactly the order desktop-main.js will use.
const { migrate } = await import("../src/db/migrate.js");
await migrate();
console.log("migrate() completed against embedded Postgres — schema.sql applied unmodified.");

// Now prove the actual pool.js (used by every route/service) works too.
const { pool } = await import("../src/db/pool.js");
const { rows } = await pool.query("SELECT current_database(), version()");
console.log("Query via the real pool.js:", rows[0]);

const { rows: tableRows } = await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
);
console.log("Tables created:", tableRows.map((r) => r.table_name).join(", "));

// Prove a write + the jobs table's FOR UPDATE SKIP LOCKED query (FASE 8)
// works on PGlite too, since the worker relies on it.
await pool.query(`INSERT INTO organizations (id, name) VALUES ('poc-org', 'PoC Org')`);
const { rows: orgRows } = await pool.query(`SELECT * FROM organizations WHERE id = 'poc-org'`);
console.log("Insert + select round-trip:", orgRows[0]);

const { rows: claimRows } = await pool.query(
  `UPDATE jobs SET status='running' WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`
);
console.log("FOR UPDATE SKIP LOCKED query executed without error (0 rows expected, no jobs queued):", claimRows.length);

await pool.end();
await embedded.stop();
console.log("\n✅ PROOF OF CONCEPT PASSED: existing backend code works unmodified against embedded Postgres.");
