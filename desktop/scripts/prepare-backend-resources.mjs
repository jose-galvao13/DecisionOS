#!/usr/bin/env node
/* ---------------------------------------------------------------
   FASE 11 — prepares src-tauri/resources/backend/ before `tauri
   build`/`tauri dev`. Copies backend/src + package.json + a
   *production-only* node_modules (no vitest/supertest — this halves
   the bundle size and, more importantly, means nothing in the shipped
   app was ever a dev dependency).

   Run via `npm run prepare` in desktop/package.json — wired into
   tauri.conf.json's beforeBuildCommand indirectly (see that file's
   comment) or can be run manually before `tauri dev` too, since dev
   mode also spawns the same sidecar against these same resources.
----------------------------------------------------------------*/
import { execSync } from "node:child_process";
import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendDir = path.resolve(__dirname, "../../backend");
const stagingDir = path.resolve(__dirname, "../.backend-staging");
const resourcesDir = path.resolve(__dirname, "../src-tauri/resources/backend");

console.log("[prepare-backend-resources] staging a production-only copy of backend/…");
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
cpSync(path.join(backendDir, "src"), path.join(stagingDir, "src"), { recursive: true });
cpSync(path.join(backendDir, "package.json"), path.join(stagingDir, "package.json"));
cpSync(path.join(backendDir, "package-lock.json"), path.join(stagingDir, "package-lock.json"));

console.log("[prepare-backend-resources] npm ci --omit=dev (production dependencies only)…");
execSync("npm ci --omit=dev --no-audit --no-fund", { cwd: stagingDir, stdio: "inherit" });

console.log(`[prepare-backend-resources] copying into ${resourcesDir}…`);
rmSync(resourcesDir, { recursive: true, force: true });
mkdirSync(path.dirname(resourcesDir), { recursive: true });
cpSync(stagingDir, resourcesDir, { recursive: true });

if (!existsSync(path.join(resourcesDir, "src", "desktop-main.js"))) {
  console.error("[prepare-backend-resources] desktop-main.js missing from staged output — aborting.");
  process.exit(1);
}

console.log("[prepare-backend-resources] done.");
