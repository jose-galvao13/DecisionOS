/* ---------------------------------------------------------------
   FASE 11 — embedded Postgres for the desktop build.

   The desktop app must run with zero installed dependencies: no
   Postgres server, no `npm install`. Rather than rewriting every
   raw-SQL query in this backend for SQLite (a big, risky rewrite —
   this app leans on real Postgres features like FOR UPDATE SKIP
   LOCKED, JSONB, LATERAL-free window functions, etc.), this starts
   PGlite — a real Postgres engine compiled to WASM — behind a
   genuine Postgres wire-protocol socket (pglite-socket). The
   existing services/db/pool.js, db/migrate.js and every route's SQL
   are completely unchanged: they just connect to
   postgres://127.0.0.1:<port>/postgres like any other Postgres.

   Not used in the normal server/team deployment (server.js) — only
   by desktop-main.js, which is what gets bundled into the Tauri
   sidecar executable. A hosted/team deployment still points
   DATABASE_URL at a real Postgres server as before.
----------------------------------------------------------------*/
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import net from "net";

/** Finds a free TCP port by asking the OS for one (port 0), same trick
 *  used for the HTTP port in desktop-main.js. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Starts embedded Postgres with its data directory under `dataDir`
 *  (the desktop app's per-user app-data folder — see desktop-main.js).
 *  Returns { port, stop() } — `stop()` closes the socket and the
 *  underlying PGlite instance cleanly (important: PGlite writes an
 *  IndexedDB-style file journal that wants a clean shutdown). */
export async function startEmbeddedPostgres(dataDir) {
  const db = new PGlite(`file://${dataDir}`);
  await db.waitReady;

  const port = await getFreePort();
  const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
  await server.start();

  return {
    port,
    connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
