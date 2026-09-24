/* ---------------------------------------------------------------
   FASE 11 — desktop entrypoint. This file (not server.js) is what
   gets compiled into the Tauri sidecar executable (see
   desktop/scripts/build-sidecar.mjs and desktop/src-tauri/src/main.rs).

   Responsibilities that only exist in desktop mode:
   1. Start embedded Postgres (services/desktop/embeddedPostgres.js) —
      the desktop app ships with zero external dependencies, so there
      is no real Postgres server to point DATABASE_URL at.
   2. Read the three secrets Tauri's Rust side resolves from the OS
      keychain (JWT signing secret, config-encryption key, and the
      user's own Anthropic API key) out of environment variables Tauri
      sets when it spawns this process — this file never touches the
      keychain itself, Rust does (src-tauri/src/secrets.rs).
   3. Bind the backend HTTP server to a FIXED port (58732) rather than
      an OS-assigned one, so the already-built frontend bundle can
      point at it via a build-time env var (VITE_DECISIONOS_API_BASE,
      see desktop/.env) with no runtime port-discovery IPC needed. If
      that port is taken, this process exits with a clear error rather
      than silently picking another one the frontend doesn't know
      about — see DESKTOP.md for the trade-off and the fallback path.
   4. Print a single machine-readable line once ready, so main.rs knows
      when it's safe to create/show the app window instead of guessing
      with a fixed delay.

   Everything else (routes, the job worker, analytics, the Decision
   Engine…) is the exact same code the hosted/team deployment runs —
   server.js and worker.js are imported completely unmodified.
----------------------------------------------------------------*/
import net from "net";
import path from "node:path";
import { startEmbeddedPostgres } from "./desktop/embeddedPostgres.js";

const FIXED_PORT = Number(process.env.DECISIONOS_DESKTOP_PORT || 58732);

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function main() {
  // Tauri passes the app's per-user data directory as the first CLI arg
  // (see src-tauri/src/main.rs) so this process never has to guess a
  // platform-specific path itself. Falling back to ./decisionos-data lets
  // this file also be run directly for local testing (see
  // scripts/poc-embedded-pg.mjs for the lower-level version of this).
  const appDataDir = process.argv[2] || path.resolve(process.cwd(), "decisionos-data");

  if (!(await isPortFree(FIXED_PORT))) {
    console.error(
      `[decisionos-desktop] port ${FIXED_PORT} is already in use — another instance of DecisionOS ` +
        `(or something else) is using it. Close it and relaunch DecisionOS.`
    );
    process.exit(1);
  }

  // Secrets: Tauri's Rust side is responsible for reading/creating these
  // via the OS keychain and setting them as env vars before spawning this
  // process (src-tauri/src/secrets.rs). If they're missing — e.g. someone
  // ran this file directly instead of through the Tauri app — generate
  // ephemeral ones so the app is still usable for local testing, but make
  // very clear that sessions won't survive a restart in that case.
  if (!process.env.JWT_SECRET || !process.env.CONFIG_ENCRYPTION_KEY) {
    console.warn(
      "[decisionos-desktop] JWT_SECRET/CONFIG_ENCRYPTION_KEY were not provided by the launcher " +
        "(expected when running via the Tauri app) — generating temporary ones for this run only. " +
        "Logins and any connected DB source's saved credentials won't survive a restart."
    );
    const { randomBytes } = await import("crypto");
    process.env.JWT_SECRET = process.env.JWT_SECRET || randomBytes(48).toString("hex");
    process.env.CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY || randomBytes(32).toString("hex");
  }
  if (!process.env.LLM_API_KEY) {
    console.warn(
      "[decisionos-desktop] no AI API key (LLM_API_KEY) configured yet — AI Advisor will be unavailable " +
        "until one is added in Settings."
    );
  }

  console.log(`[decisionos-desktop] starting embedded Postgres in ${path.join(appDataDir, "pgdata")}…`);
  const embedded = await startEmbeddedPostgres(path.join(appDataDir, "pgdata"));
  console.log(`[decisionos-desktop] embedded Postgres ready`);

  process.env.DATABASE_URL = embedded.connectionString;
  process.env.PORT = String(FIXED_PORT);
  process.env.WORKER_ENABLED = "true"; // single process, no separate worker needed on desktop
  // The webview's origin for a Tauri v2 app. Both forms are included since
  // it varies slightly by OS/webview (WebView2 on Windows, WKWebView on
  // macOS, WebKitGTK on Linux) — see DESKTOP.md.
  process.env.ALLOWED_ORIGINS = "http://tauri.localhost,tauri://localhost";

  const { start } = await import("./server.js");
  const httpServer = await start();

  // main.rs watches stdout for this exact line to know when to show the
  // window — do not change this format without updating src-tauri/src/main.rs.
  console.log(`DECISIONOS_DESKTOP_READY port=${httpServer.address().port}`);

  const shutdown = async () => {
    console.log("[decisionos-desktop] shutting down…");
    await new Promise((resolve) => httpServer.close(resolve));
    await embedded.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Windows has no POSIX signals, so the Tauri shell (src-tauri/src/main.rs)
  // asks for a clean shutdown by writing a line to this process's stdin
  // instead — a pipe, unlike a signal, behaves the same on every platform.
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (chunk.trim() === "shutdown") shutdown();
  });
  process.stdin.resume();
}

main().catch((e) => {
  console.error("[decisionos-desktop] fatal startup error:", e);
  process.exit(1);
});
