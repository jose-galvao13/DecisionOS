#!/usr/bin/env node
/* ---------------------------------------------------------------
   FASE 11 — local dev/build convenience. `tauri dev`/`tauri build`
   need a sidecar binary already sitting at
   src-tauri/binaries/node-<host-target-triple>[.exe] (see
   tauri.conf.json's externalBin). CI computes this per-OS in
   .github/workflows/desktop-build.yml; for a local run on your own
   machine, this script does the same thing using your own installed
   Node binary and your own Rust host triple.

   Requires `rustc` on PATH (you need it anyway to run `tauri
   dev`/`tauri build` themselves).
----------------------------------------------------------------*/
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const binariesDir = path.resolve(__dirname, "../src-tauri/binaries");

let triple;
try {
  triple = execSync("rustc -vV", { encoding: "utf8" }).match(/^host: (.+)$/m)?.[1];
} catch {
  console.error("[stage-sidecar-local] `rustc` not found on PATH — install Rust first (see DESKTOP.md).");
  process.exit(1);
}
if (!triple) {
  console.error("[stage-sidecar-local] could not determine host target triple from `rustc -vV`.");
  process.exit(1);
}

mkdirSync(binariesDir, { recursive: true });
const isWindows = process.platform === "win32";
const dest = path.join(binariesDir, `node-${triple}${isWindows ? ".exe" : ""}`);
copyFileSync(process.execPath, dest);
if (!isWindows) chmodSync(dest, 0o755);

console.log(`[stage-sidecar-local] staged ${process.execPath} -> ${dest}`);
