import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./test/setupEnv.js"],
    coverage: {
      reporter: ["text", "html"],
      exclude: ["test/**", "src/db/migrate.js", "src/server.js"],
    },
  },
});
