// FASE 11 — secure storage. Three secrets the backend needs are never
// written to a plaintext file:
//   1. jwt_secret             — auto-generated once, signs login tokens
//   2. config_encryption_key  — auto-generated once, encrypts any saved
//                                Postgres-connector credentials at rest
//                                (see backend/src/utils/crypto.js)
//   3. anthropic_api_key      — the user's own key, pasted once in
//                                Settings (see get_anthropic_key /
//                                set_anthropic_key Tauri commands below)
//
// All three live in the OS's native secret store via the `keyring` crate:
// Windows Credential Manager, macOS Keychain, or the Linux Secret Service
// (gnome-keyring / kwallet). This process (the Rust app) is the only place
// that touches the keychain; the two auto-generated secrets are resolved
// once at startup and handed to the Node sidecar as environment variables
// — the sidecar process never reads or writes the keychain itself.
use keyring::Entry;
use rand::RngCore;

const SERVICE: &str = "app.decisionos.desktop";

fn entry(account: &str) -> keyring::Result<Entry> {
    Entry::new(SERVICE, account)
}

fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Returns the stored secret for `account`, generating and persisting a new
/// one on first run. Used for jwt_secret (48 random bytes -> 96 hex chars)
/// and config_encryption_key (32 random bytes -> 64 hex chars, matching
/// utils/crypto.js's expectation of a 32-byte AES-256 key).
pub fn get_or_create_secret(account: &str, byte_len: usize) -> Result<String, String> {
    let e = entry(account).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(existing) => Ok(existing),
        Err(keyring::Error::NoEntry) => {
            let generated = random_hex(byte_len);
            e.set_password(&generated).map_err(|e| e.to_string())?;
            Ok(generated)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Reads the user's own Anthropic API key, if they've saved one. Returns
/// None (not an error) when nothing has been saved yet — the backend
/// already handles a missing key gracefully (AI Advisor returns a clear
/// 500 instead of crashing; see server.js).
pub fn get_anthropic_key() -> Option<String> {
    entry("anthropic_api_key").ok()?.get_password().ok()
}

pub fn set_anthropic_key(key: &str) -> Result<(), String> {
    let e = entry("anthropic_api_key").map_err(|e| e.to_string())?;
    if key.trim().is_empty() {
        // Treat saving an empty string as "remove the key" rather than
        // storing an empty secret.
        return e.delete_credential().map_err(|e| e.to_string());
    }
    e.set_password(key.trim()).map_err(|e| e.to_string())
}

// --- Tauri commands exposed to the frontend Settings page ---------------
// Deliberately the ONLY two secret-related commands exposed to the
// webview. The frontend can set/check the Anthropic key; it can never read
// jwt_secret or config_encryption_key (those never leave this process).

#[tauri::command]
pub fn has_anthropic_key() -> bool {
    get_anthropic_key().is_some_and(|k| !k.is_empty())
}

#[tauri::command]
pub fn save_anthropic_key(key: String) -> Result<(), String> {
    set_anthropic_key(&key)
}
