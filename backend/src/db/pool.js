import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "[decisionos-backend] DATABASE_URL is not set. All /api/auth, /api/org, " +
      "/api/datasources and /api/analytics routes will fail until it's configured (see .env.example)."
  );
}

// Managed Postgres (RDS, Supabase, Render, Railway...) almost always needs
// SSL but with a certificate we don't have locally — PGSSL=require gives
// you that without rejecting the self-signed chain. Set PGSSL=disable for
// plain local dev.
const ssl =
  process.env.PGSSL === "disable"
    ? false
    : process.env.PGSSL === "require"
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on("error", (err) => {
  // Idle client errors shouldn't crash the process.
  console.error("[decisionos-backend] unexpected Postgres pool error", err);
});

export async function query(text, params) {
  return pool.query(text, params);
}

/** Run `fn` inside a transaction, rolling back on any thrown error. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
