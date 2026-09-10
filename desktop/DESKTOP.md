# DecisionOS Desktop (FASE 11)

Wraps the existing React frontend and Node backend into a real installable
app — `DecisionOS-Setup.exe` on Windows, a `.dmg` on macOS — with no
`npm install`, `npm run dev`, or `node server.js` for the end user.

## Architecture

```
                 DecisionOS.exe / .app
                          │
                    Tauri shell (Rust)
                    - creates the window
                    - resolves 3 secrets from the OS keychain
                    - spawns the sidecar below, waits for it to
                      report ready, then shows the window
                          │
              ┌───────────┴────────────┐
              │                        │
     bundled Node.js binary   already-built frontend
     running desktop-main.js   (static files, loaded
     (real backend code,       directly into the webview)
      unmodified) ── connects to
              │
     embedded Postgres (PGlite, real Postgres
     compiled to WASM, behind a genuine Postgres
     wire-protocol socket) — no external DB needed
```

Two decisions made this work without a large rewrite, and both were
**tested for real**, not just written and hoped for (see
`backend/scripts/poc-embedded-pg.mjs` and the sequence of manual sidecar
tests described below):

1. **Database**: instead of porting every raw-SQL query to SQLite,
   [`@electric-sql/pglite`](https://pglite.dev) runs a real Postgres engine
   (compiled to WASM) behind
   [`@electric-sql/pglite-socket`](https://github.com/electric-sql/pglite/tree/main/packages/pglite-socket),
   which speaks the actual Postgres wire protocol on a local port. The
   existing `pg.Pool`-based code (`db/pool.js`, every route's raw SQL, even
   the FASE 8 `FOR UPDATE SKIP LOCKED` job-queue query) runs completely
   unmodified against it. Proven in `backend/scripts/poc-embedded-pg.mjs`.

2. **Backend packaging**: the first approach tried was `pkg` (bundling
   `desktop-main.js` into a single executable). It failed with a real,
   reproducible error — PGlite's WASM loader uses a dynamic `import()` that
   pkg's V8-snapshot module loader can't intercept. Rather than fight that,
   the sidecar is a **bundled real Node.js binary** spawned against plain
   backend files copied into the app's resources — the well-worn "Tauri +
   Node sidecar" pattern, and exactly the code path already proven to work
   standalone.

## What's actually been verified, and how

Run these yourself to reproduce:

```bash
cd backend
npm install
node scripts/poc-embedded-pg.mjs
# -> starts embedded Postgres, runs the real migrate.js against it,
#    round-trips a query through the real pool.js, and runs the FASE 8
#    FOR UPDATE SKIP LOCKED query — all against PGlite, all unmodified.

# Prove the sidecar entrypoint itself works standalone:
JWT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
CONFIG_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd \
node src/desktop-main.js /tmp/decisionos-test-data &
curl -X POST http://127.0.0.1:58732/api/auth/register -H 'Content-Type: application/json' \
  -d '{"orgName":"Test","name":"Me","email":"me@test.com","password":"password123"}'
# -> a real JWT + user, from a real HTTP call, against embedded Postgres.

cd ../desktop
npm install
npm run prepare-backend
# -> stages a production-only copy of backend/ into src-tauri/resources/backend/
#    (same npm ci --omit=dev + copy this doc describes CI doing per-platform)
```

All of the above has actually been run and produces the output described —
this isn't aspirational.

## What has NOT been verified (and why)

The Rust side (`src-tauri/src/main.rs`, `secrets.rs`, `Cargo.toml`,
`tauri.conf.json`) was written carefully against the Tauri v2 /
`tauri-plugin-shell` v2 API surface, but **could not be compiled** in the
sandbox that produced it:

- Ubuntu's `apt` ships `rustc` 1.75; Tauri v2 requires 1.77.2+.
- `rustup`'s own servers aren't reachable from that sandbox to install a
  newer toolchain (only a fixed allowlist of package registries is).
- Actually producing a `.exe` or `.dmg` needs a native Windows/macOS build
  environment regardless — that's true even outside this constraint, which
  is why the CI workflow below exists.

**Before trusting this, run `cargo check` inside `desktop/src-tauri` on a
machine with Rust 1.77.2+** and fix whatever it flags. The architecture and
the JS/Node side are solid; the Rust glue is the one part that's "should
compile" rather than "does compile."

## Building for real

### Via CI (recommended — this is what actually produces the installers)

`.github/workflows/desktop-build.yml` builds on GitHub's native
Windows/macOS/Linux runners (a real .exe needs a real Windows toolchain; no
sandbox changes that). Trigger it manually (Actions tab → "Desktop build
(FASE 11)" → Run workflow) or by pushing a `desktop-v*` tag. Downloads a
`decisionos-<os>` artifact per platform containing the installer.

### Locally

Requires Rust 1.77.2+ (rustup.rs) and the platform's Tauri prerequisites
(see Tauri's own prerequisites page — WebView2 comes with Windows 10/11
already; macOS needs Xcode Command Line Tools; Linux needs
`libwebkit2gtk-4.1-dev` and friends).

```bash
cd frontend && npm install
cd ../backend && npm install
cd ../desktop && npm install
npm run build   # stages backend resources + sidecar, then `tauri build`
```

Output lands in `desktop/src-tauri/target/release/bundle/` (`nsis/*.exe` on
Windows, `dmg/*.dmg` + `macos/*.app` on macOS, `appimage/*.AppImage` +
`deb/*.deb` on Linux).

For iterative development: `npm run dev` (runs the frontend dev server +
Tauri in dev mode; the sidecar still talks to embedded Postgres on
127.0.0.1:58732 exactly like the built app does).

## Secure storage

Three secrets, all in the OS-native credential store (Windows Credential
Manager / macOS Keychain / Linux Secret Service) via the Rust `keyring`
crate — **never in a plaintext file**:

| Secret | Origin | Purpose |
|---|---|---|
| `jwt_secret` | auto-generated on first launch | signs login tokens |
| `config_encryption_key` | auto-generated on first launch | encrypts any saved DB-connector credentials at rest |
| `anthropic_api_key` | pasted by the user in Settings | AI Advisor — desktop is single-user, so bring-your-own-key rather than a server-side key shared across tenants |

Rust is the only thing that ever touches the keychain; the two
auto-generated secrets are resolved once at startup and handed to the Node
sidecar as environment variables, and the sidecar process itself never
reads or writes the keychain. The frontend can only call `has_anthropic_key`
/ `save_anthropic_key` (see `src-tauri/src/secrets.rs`'s two
`#[tauri::command]`s) — it can never read `jwt_secret` or
`config_encryption_key` back out.

## Filesystem / permissions

- `capabilities/default.json` grants the main window exactly one thing
  beyond Tauri's own defaults: permission to execute the bundled `node`
  sidecar — nothing else (no arbitrary shell, no filesystem-read/write API
  exposed to the webview).
- `tauri.conf.json`'s CSP (`connect-src 'self' http://127.0.0.1:58732`)
  means the webview can only make network requests to the app's own local
  backend, never anywhere else.
- Embedded Postgres's data directory lives under the OS's normal per-user
  app-data folder (`app_data_dir()` — e.g. `%APPDATA%\app.decisionos.desktop`
  on Windows), which already has correct per-user permissions by OS
  convention; nothing here changes those.

## Known limitations / follow-ups

- **Fixed backend port (58732)**: chosen for simplicity over a dynamic
  port + IPC round-trip to tell the frontend which port to use. If that
  port is already taken by something else on the user's machine, the app
  currently fails to start with a clear log message rather than falling
  back to another port. A future improvement: probe a few alternate ports
  and expose the chosen one via a Tauri command the frontend calls before
  its first request.
- **`tauri-plugin-single-instance`** guards against two copies of the app
  running against the same embedded-Postgres data directory concurrently
  (which, like real Postgres, it doesn't support) — a second launch
  focuses the existing window instead of starting a second sidecar.
- **Windows has no POSIX signals**, so graceful shutdown (flushing embedded
  Postgres cleanly) is done by writing `"shutdown\n"` to the sidecar's
  stdin instead of a signal — verified in isolation (see
  `backend/src/desktop-main.js`'s stdin handler), not yet verified through
  an actual compiled Tauri app's exit path.
- **No auto-update** wired up yet (`tauri-plugin-updater` would be the next
  step once there's a release channel to point it at).

## Testing a clean install / uninstall / reinstall

Once you have a built installer (via CI or locally), this is what to
actually click through — none of it can be exercised in a sandbox without
a real OS:

**Clean install**
1. On a machine that has never had DecisionOS installed, run the
   installer. Confirm no admin prompt is required for a per-user
   install (`nsis.installMode: "currentUser"` in `tauri.conf.json`).
2. Launch the app. First launch should show a brief blank/loading window
   (embedded Postgres init + schema migration takes a couple of seconds)
   before the login/register screen appears.
3. Register an org, import a small Excel file, confirm the Fase 8 async
   import progress bar and the rest of the app work identically to the
   web version.
4. Quit the app normally (not force-quit). Relaunch — confirm your org and
   imported data are still there (proves embedded Postgres persisted to
   the app-data directory and shut down cleanly).

**Uninstall**
1. Uninstall via the OS's normal mechanism (Windows: Settings → Apps;
   macOS: drag to Trash, or the generated uninstaller).
2. Confirm the app-data directory (containing the imported data) is
   **not** deleted by uninstall — this is deliberate (see below); verify
   it's still at the expected path.
3. Confirm no leftover process is still running (check Task
   Manager/Activity Monitor for a stray `node` sidecar process).

**Reinstall**
1. Reinstall without manually deleting the app-data directory.
2. Launch — confirm the previous org/data is still there and nothing
   breaks. This is why secrets live in the OS keychain rather than being
   generated fresh per-install: a fresh `jwt_secret` would silently
   invalidate old logins, which would be a confusing surprise after a
   reinstall the user expected to be a no-op for their data.

**Why uninstall doesn't delete data**: an uninstalled-then-reinstalled app
that silently lost the org's imported data would be a much worse surprise
than a few dozen MB left on disk. If you want a full reset for testing,
delete the app-data directory yourself between runs.
