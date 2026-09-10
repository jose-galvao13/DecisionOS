// Minimal migration runner: schema.sql is entirely CREATE TABLE/INDEX IF NOT
// EXISTS, so re-running it is always safe. Good enough for FASE 1; swap for
// a real migration tool (node-pg-migrate, Prisma Migrate...) once the schema
// starts changing under existing data instead of only growing.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const sql = readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("[decisionos-backend] schema migrated (organizations, users, data_sources, unified data model, data_quality_reports, audit_log)");
}

// Allow `node src/db/migrate.js` directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[decisionos-backend] migration failed", e);
      process.exit(1);
    });
}
