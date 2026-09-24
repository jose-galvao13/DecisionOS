import crypto from "crypto";

// CONFIG_ENCRYPTION_KEY must be a 32-byte key, hex-encoded (64 hex chars).
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// This is what protects PostgreSQL/MySQL/SQL Server passwords stored in
// data_sources.connection_config — never store connector credentials
// unencrypted, and never reuse LLM_API_KEY or JWT_SECRET for this.
function getKey() {
  const hex = process.env.CONFIG_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY is missing or not a 64-char hex string (32 bytes) — see .env.example"
    );
  }
  return Buffer.from(hex, "hex");
}

/** Encrypt a JS value (JSON-stringified) into a single base64 blob: iv|tag|ciphertext. */
export function encryptJSON(value) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** Reverse of encryptJSON. */
export function decryptJSON(blob) {
  const key = getKey();
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}
