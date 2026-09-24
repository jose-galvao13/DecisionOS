# E2E tests (Playwright)

`full-flow.spec.js` drives the whole roadmap flow — register, import a real
dataset, watch it land through the FASE 8 async job pipeline, then look at
analytics, a decision, the AI Advisor, and the simulator — against a real
running backend + Postgres. It is **not** part of `npm test`; it needs a
live stack, unlike the vitest suite (which mocks the DB).

## Running it locally

1. Start Postgres and the backend (see `backend/README.md` / `.env.example`).
   Make sure `LLM_API_KEY` is set — the "Ask Advisor" step is a real
   call to the Advisor endpoint, which calls the Anthropic API.
2. Start the frontend dev server: `npm run dev` (defaults to
   `http://localhost:5173`, matching `playwright.config.js`).
3. Install browsers once: `npx playwright install --with-deps chromium`.
4. Run: `npm run test:e2e`.

Point it at a different frontend URL with `E2E_BASE_URL=... npm run test:e2e`
(e.g. a staging deploy).

## Why this isn't wired into CI here

This repo's automated `npm test` (vitest, backend + frontend) runs with a
mocked DB/no external services and is fast enough to run on every push.
This E2E suite needs a database, a backend process, an Anthropic API key,
and a browser — wire it into your CI as a separate, slower job (e.g.
nightly, or gated on a `docker compose up` step that provisions Postgres)
rather than blocking every commit on it.

## Test data

The spec generates its own small `.xlsx` fixture in memory (6 months of a
single product with declining volume) so the Decision Engine has a real
revenue decline to surface — an all-flat dataset wouldn't produce anything
to click through to in the Decision Feed / Advisor / Simulator steps.
