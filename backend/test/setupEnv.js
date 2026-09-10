// Runs before every test file (see vitest.config.js). Provides fake but
// well-formed secrets so auth/jwt.js and utils/crypto.js don't throw their
// "missing config" errors during tests that don't otherwise touch a real
// Postgres or Anthropic key.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-not-for-production-use-0123456789";
process.env.CONFIG_ENCRYPTION_KEY =
  process.env.CONFIG_ENCRYPTION_KEY || "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd";
process.env.DATABASE_URL = process.env.DATABASE_URL || "";
process.env.WORKER_ENABLED = "false";
process.env.MEASUREMENT_LOOP_ENABLED = "false";
