import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.js"],
    css: false,
    exclude: ["**/node_modules/**", "e2e/**"], // e2e/ is Playwright, run via `npm run test:e2e`, not vitest
  },
});
