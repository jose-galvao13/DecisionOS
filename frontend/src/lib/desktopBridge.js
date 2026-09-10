/* ---------------------------------------------------------------
   FASE 11 — desktop-only bridge. The hosted/web build of this
   frontend never has a `window.__TAURI__`, so every function here is
   a safe no-op there; only the desktop build (built via
   `npm run build:tauri`, wrapped by Tauri) actually calls into Rust.
----------------------------------------------------------------*/
export function isDesktopApp() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke(cmd, args) {
  if (!isDesktopApp()) throw new Error("not running inside the desktop app");
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke(cmd, args);
}

/** Whether the user has already saved an Anthropic API key in this
 *  install (see src-tauri/src/secrets.rs — stored in the OS keychain,
 *  never in a plaintext file). */
export function hasAnthropicKey() {
  return invoke("has_anthropic_key");
}

/** Saves (or, given an empty string, removes) the user's Anthropic API
 *  key. Only ever sent to Rust -> OS keychain -> the backend sidecar's
 *  environment at next launch; never persisted anywhere the frontend
 *  itself could read it back from. */
export function saveAnthropicKey(key) {
  return invoke("save_anthropic_key", { key });
}
