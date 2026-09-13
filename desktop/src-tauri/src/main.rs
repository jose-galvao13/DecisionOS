// FASE 11 — desktop shell entrypoint.
//
// NOTE ON VERIFICATION: this file was written carefully against the
// Tauri v2 / tauri-plugin-shell v2 API surface, but could not be
// compiled in the environment that produced it — apt's rustc (1.75) is
// older than Tauri v2's minimum (1.77.2), and rustup's own servers
// aren't reachable from that sandbox to install a newer toolchain. Run
// `cargo check` here (see DESKTOP.md) before trusting this blindly.
//
// What's real and already proven (see backend/scripts/poc-embedded-pg.mjs
// and the manual "resource bundle simulation" described in DESKTOP.md):
// the sidecar script this spawns (backend/src/desktop-main.js) has
// actually been run standalone, registered a real user through the real
// HTTP API, against a real embedded Postgres. What's unverified here is
// only the Rust glue that spawns it and wires up the OS keychain.

mod secrets;

use std::sync::Mutex;
use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct SidecarState(Mutex<Option<CommandChild>>);

/// Tries the two layouts `resource_dir()` has been observed to produce
/// across Tauri versions/bundlers for a `"resources/backend/**/*": "backend/"`
/// mapping — with the `resources/` segment already stripped, and with it
/// still present. Falls back to the first candidate (preserving the
/// original panic-with-a-clear-message behavior) but only after printing
/// a full directory listing of resource_dir(), so a second wrong guess is
/// not needed: the next log tells us exactly what's really on disk.
fn locate_backend_entry(resource_dir: &std::path::Path) -> std::path::PathBuf {
    let candidates = [
        resource_dir.join("backend").join("src").join("desktop-main.js"),
        resource_dir
            .join("resources")
            .join("backend")
            .join("src")
            .join("desktop-main.js"),
    ];
    for candidate in &candidates {
        if candidate.exists() {
            println!("[main] found desktop-main.js at {:?}", candidate);
            return candidate.clone();
        }
    }
    eprintln!(
        "[main] could not find desktop-main.js in either expected location under {:?}",
        resource_dir
    );
    eprintln!("[main] actual contents of resource_dir() (up to 4 levels deep):");
    print_dir_tree(resource_dir, 0);
    candidates[0].clone()
}

fn print_dir_tree(dir: &std::path::Path, depth: usize) {
    if depth > 4 {
        return;
    }
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                eprintln!("[main] {}{}", "  ".repeat(depth), path.display());
                if path.is_dir() {
                    print_dir_tree(&path, depth + 1);
                }
            }
        }
        Err(e) => eprintln!("[main] {}<could not read dir: {}>", "  ".repeat(depth), e),
    }
}

fn main() {
    tauri::Builder::default()
        // Prevents a second DecisionOS window from starting a second
        // embedded-Postgres instance against the same on-disk data
        // directory (which PGlite, like real Postgres, does not support
        // concurrently) and from trying to bind the same fixed backend
        // port twice. Focuses the existing window instead.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            secrets::has_anthropic_key,
            secrets::save_anthropic_key,
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            // Secrets: resolved once here, handed to the sidecar as env
            // vars. See secrets.rs for why these three and not more.
            let jwt_secret = secrets::get_or_create_secret("jwt_secret", 48)
                .expect("failed to read/create jwt_secret in the OS keychain");
            let config_key = secrets::get_or_create_secret("config_encryption_key", 32)
                .expect("failed to read/create config_encryption_key in the OS keychain");
            let anthropic_key = secrets::get_anthropic_key().unwrap_or_default();

            // Per-user, per-app data directory (e.g. %APPDATA%\app.decisionos.desktop
            // on Windows, ~/Library/Application Support/app.decisionos.desktop on
            // macOS, ~/.local/share/app.decisionos.desktop on Linux) — this is
            // where embedded Postgres's data files live, persisted across restarts
            // and untouched by uninstall unless the user removes it deliberately
            // (see DESKTOP.md's "uninstall" section for why that's the right default).
            let app_data_dir = app_handle
                .path()
                .app_data_dir()
                .expect("could not resolve app data directory");
            std::fs::create_dir_all(&app_data_dir)?;

            // The resource path Tauri copies `resources/backend/**` to at build
            // time (see tauri.conf.json's bundle.resources mapping). Whether
            // resource_dir() itself already includes a nested "resources"
            // folder, or points straight at the resource payload root, has
            // genuinely differed across Tauri versions/platforms — rather
            // than assume one and risk a silent wrong guess, try both real
            // candidates, and if neither exists, dump what's actually there
            // so the next run's log is diagnostic instead of another guess.
            let resource_dir = app_handle
                .path()
                .resource_dir()
                .expect("could not resolve resource directory");
            let backend_entry = locate_backend_entry(&resource_dir);

            let sidecar = app_handle
                .shell()
                .sidecar("node")
                .expect("failed to locate the bundled node sidecar binary")
                .args([
                    backend_entry.to_string_lossy().to_string(),
                    app_data_dir.to_string_lossy().to_string(),
                ])
                .env("JWT_SECRET", jwt_secret)
                .env("CONFIG_ENCRYPTION_KEY", config_key)
                .env("ANTHROPIC_API_KEY", anthropic_key);

            let (mut rx, child) = sidecar.spawn().expect("failed to spawn backend sidecar");
            *app_handle.state::<SidecarState>().0.lock().unwrap() = Some(child);

            // Stream the sidecar's stdout/stderr into this app's own log (so
            // `RUST_LOG`/terminal output during `tauri dev` shows backend logs
            // too) and watch for the readiness line desktop-main.js prints —
            // only then is it safe to show the window instead of a blank/loading
            // webview racing the backend's startup (embedded Postgres + schema
            // migration takes a couple of seconds on first run).
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            let text = String::from_utf8_lossy(&line);
                            println!("[backend] {}", text.trim_end());
                            if text.contains("DECISIONOS_DESKTOP_READY") {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        CommandEvent::Stderr(line) => {
                            eprintln!("[backend] {}", String::from_utf8_lossy(&line).trim_end());
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[backend] sidecar exited: {:?}", payload);
                            // The backend is the whole app's reason to exist —
                            // if it dies unexpectedly, don't leave a dead window
                            // open with every API call failing silently.
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.close();
                            }
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the DecisionOS app")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Windows has no POSIX SIGTERM, so a signal-based graceful
                // shutdown (which desktop-main.js already supports) isn't
                // reachable from here on every platform — writing to the
                // child's stdin is, since pipes work the same way on all
                // three. desktop-main.js listens for this exact line and
                // runs the same clean-shutdown path (close HTTP server,
                // stop embedded Postgres) before exiting on its own.
                let state = app_handle.state::<SidecarState>();
                // Split the lock+take into its own statement: the MutexGuard
                // temporary from `.lock().unwrap()` needs to be dropped right
                // here, not still alive across the `if let` block below —
                // keeping it alive that long is what the borrow checker
                // rejected (E0597). `.take()` already gives us an owned
                // `Option<CommandChild>`, so nothing below actually needs
                // the guard anymore.
                let maybe_child = state.0.lock().unwrap().take();
                if let Some(mut child) = maybe_child {
                    let _ = child.write("shutdown\n".as_bytes());
                    // Give it a moment to flush embedded Postgres to disk
                    // cleanly; fall back to a hard kill if it's still alive
                    // after that so the app doesn't hang on quit.
                    std::thread::sleep(std::time::Duration::from_millis(1500));
                    let _ = child.kill();
                }
            }
        });
}
