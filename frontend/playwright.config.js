import { defineConfig } from "@playwright/test";

// FASE 9 E2E — this suite drives the real app in a browser against a real
// backend (see README in e2e/ for how to stand one up). It is NOT run as
// part of `npm test` because it needs live Postgres + a running backend +
// frontend dev server — CI wires that up separately (see FASE 9 checklist:
// "Idealmente: Register -> Create organization -> Import dataset ->
// Data quality -> Analytics -> Decision -> Ask Advisor -> Simulation").
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false, // each test registers a fresh org — order-independent, but no need to parallelize a single flow
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
