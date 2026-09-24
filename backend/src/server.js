import "dotenv/config";
import "express-async-errors";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { AI_TOOLS_SCHEMA, runTool, isPortfolioTool, PORTFOLIO_ADVISOR_GUARDRAILS } from "./analytics-tools.js";
import { migrate } from "./db/migrate.js";
import { loadSessionState } from "./services/userAdmin.js";
import { startWorker } from "./worker.js";
import { startMeasurementLoop } from "./services/measurementEngine.js";
import { requireAuth } from "./auth/middleware.js";
import { chatCompletion, isLlmConfigured, parseToolArgs, LlmError } from "./llm.js";
import { computeAnalyticsForOrg } from "./services/analyticsEngine.js";
import { loadPortfolioContext } from "./services/portfolioData.js";
import authRoutes from "./routes/auth.routes.js";
import organizationsRoutes from "./routes/organizations.routes.js";
import datasourcesRoutes from "./routes/datasources.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import decisionsRoutes from "./routes/decisions.routes.js";
import decisionRecordsRoutes from "./routes/decisionRecords.routes.js";
import simulationRoutes from "./routes/simulation.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import portfolioRoutes from "./routes/portfolio.routes.js";
import priceHistoryRoutes from "./routes/priceHistory.routes.js";

const PORT = process.env.PORT || 8787;

if (!isLlmConfigured()) {
  console.warn(
    "[decisionos-backend] LLM_API_KEY is not set. /api/advisor and /api/chat will return 500s until it's configured (see .env.example)."
  );
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" })); // analytics payloads can be a few hundred KB, not more

// --- CORS: only the frontend origins listed here may call this API -------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      // allow no-origin requests (curl, server-to-server health checks)
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error("Not allowed by CORS"));
    },
  })
);

// --- Basic rate limiting: protects the LLM quota/bill, not a substitute
// for real per-tenant quotas. Now that auth/orgs exist (FASE 1), this could
// be keyed by req.user.orgId instead of just IP — left as IP-based for now
// since /api/auth/* has to work before a user has a token.
app.use(
  "/api/",
  rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// --- FASE 1 routes: auth, organizations/users/roles, data sources
// (Excel + PostgreSQL), and the first DB-backed analytics endpoint. ------
app.use("/api/auth", authRoutes);
app.use("/api/org", organizationsRoutes);
app.use("/api/datasources", datasourcesRoutes);
app.use("/api/analytics", analyticsRoutes);
// Parte 2, FASE 1 — Carteira de ações (stock portfolio), by upload. Its
// own model (portfolio_imports/holdings/security_prices — see
// db/schema.sql) rather than data_sources/transactions, since a holding
// isn't a sales transaction; the import plumbing (staging/jobQueue/worker)
// is reused as-is.
app.use("/api/portfolio", portfolioRoutes);
// Parte 2, FASE 3 — "Risco com histórico de preços": price_history table,
// services/riskAnalytics.js and the optional services/marketData.js API,
// all mounted under the same /api/portfolio prefix as its own router file
// so portfolio.routes.js doesn't grow into a second, unrelated concern.
app.use("/api/portfolio", priceHistoryRoutes);

// --- FASE 3 / FASE 4: Decision Engine + Simulation Engine, both built on
// top of the same computeAnalyticsForOrg() the routes above already use. -
app.use("/api/decisions", decisionsRoutes);
// P1 — persisted decision lifecycle (creation/history/owner/approval/
// outcome). Deliberately a different path from /api/decisions above:
// that one recomputes the Decision Engine fresh from current data on
// every call (DETECT/EXPLAIN); this one is the record of what was
// actually decided (DECIDE/ACT/MEASURE) — see decisionRecords.js's header.
app.use("/api/decision-log", decisionRecordsRoutes);
app.use("/api/simulate", simulationRoutes);
app.use("/api/notifications", notificationsRoutes);

// Friendly HTTP status for provider errors (free tiers hit rate limits a lot).
function llmErrorResponse(res, e, fallbackMsg) {
  if (e instanceof LlmError && e.status === 429) {
    return res.status(429).json({ error: "AI provider rate limit reached — wait a few seconds and try again" });
  }
  return res.status(500).json({ error: fallbackMsg });
}

/* ---------------------------------------------------------------
   POST /api/advisor
   Body: { system: string, userText: string, filters?: object, maxRounds?: number }
   Runs the full tool-calling loop server-side: the model decides which
   analytics tool(s) it needs, we execute them here, feed results back,
   repeat until Claude answers in plain text. The frontend never talks to
   the LLM provider directly and never runs a tool itself.

   FASE 2 change (closes roadmap 🔴 #2 — "tirar os dados de confiança do
   browser"): `analytics` is no longer accepted from the request body at
   all. This endpoint computes it itself, server-side, from
   req.user.orgId's own data in Postgres (via analyticsEngine.js — the
   same engine analytics.routes.js's GET /api/analytics/full uses), honoring
   the same optional `filters` { period, product, region, channel } the
   frontend's filter bar already sends. A client can no longer get Claude
   to "confirm" a fabricated analytics payload as real company data,
   because it's never given the chance to supply one.
----------------------------------------------------------------*/
app.post("/api/advisor", requireAuth, async (req, res) => {
  const { system, userText, filters, maxRounds = 4 } = req.body || {};
  if (!system || !userText) {
    return res.status(400).json({ error: "system and userText are required" });
  }
  if (!isLlmConfigured()) {
    return res.status(500).json({ error: "server is not configured with an LLM API key (LLM_API_KEY)" });
  }

  const analytics = await computeAnalyticsForOrg(req.user.orgId, filters || {});
  // Parte 2, FASE 4: an org with a stock portfolio but no sales data can
  // still use the portfolio tools, so "no transactions" is only a 404 when
  // there is no portfolio either. Otherwise the portfolio is loaded lazily,
  // the first time Claude calls one of the portfolio tools.
  let portfolio = null;
  if (!analytics) {
    portfolio = await loadPortfolioContext(req.user.orgId);
    if (!portfolio.analytics.positions.length) {
      return res.status(404).json({ error: "no transactions found for this organization yet — connect or upload a data source first" });
    }
  }
  // Appended here, not left to the client's prompt, so the portfolio rules
  // (describe risk and scenarios, never recommend buying/selling, add the
  // not-financial-advice notice) can't be dropped by whoever calls this.
  const systemPrompt = `${system}\n\n${PORTFOLIO_ADVISOR_GUARDRAILS}`;

  try {
    let messages = [{ role: "user", content: userText }];
    for (let round = 0; round < maxRounds; round++) {
      const msg = await chatCompletion({
        system: systemPrompt,
        messages,
        tools: AI_TOOLS_SCHEMA,
        maxTokens: 1200,
      });
      const toolCalls = msg.tool_calls || [];

      if (!toolCalls.length) {
        const text = (msg.content || "").trim();
        if (!text) return res.status(502).json({ error: "empty response from model" });
        return res.json({ text });
      }

      messages = [...messages, { role: "assistant", content: msg.content || "", tool_calls: toolCalls }];
      if (!portfolio && toolCalls.some((tc) => isPortfolioTool(tc.function?.name))) {
        portfolio = await loadPortfolioContext(req.user.orgId);
      }
      const toolResults = toolCalls.map((tc) => ({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(runTool(tc.function?.name, parseToolArgs(tc.function?.arguments), { analytics, portfolio })),
      }));
      messages = [...messages, ...toolResults];
    }
    return res.status(504).json({ error: "tool-call round limit reached" });
  } catch (e) {
    console.error("[/api/advisor]", e);
    return llmErrorResponse(res, e, "internal error calling AI advisor");
  }
});

/* ---------------------------------------------------------------
   POST /api/chat
   Body: { system: string, userText: string, json?: boolean }
   Single-shot call (no tools) — used by the lightweight chat widget
   that answers from a pre-built digest rather than live tool calls.
----------------------------------------------------------------*/
app.post("/api/chat", requireAuth, async (req, res) => {
  const { system, userText, json } = req.body || {};
  if (!system || !userText) {
    return res.status(400).json({ error: "system and userText are required" });
  }
  if (!isLlmConfigured()) {
    return res.status(500).json({ error: "server is not configured with an LLM API key (LLM_API_KEY)" });
  }

  try {
    const msg = await chatCompletion({
      system,
      messages: [{ role: "user", content: userText }],
      maxTokens: 1000,
    });
    const text = (msg.content || "").trim();
    if (!text) return res.status(502).json({ error: "empty response from model" });

    if (json) {
      try {
        const clean = text.replace(/```json|```/g, "").trim();
        return res.json({ json: JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1)) });
      } catch {
        return res.status(502).json({ error: "model did not return valid JSON" });
      }
    }
    return res.json({ text });
  } catch (e) {
    console.error("[/api/chat]", e);
    return llmErrorResponse(res, e, "internal error calling chat");
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  if (err && err.message === "Not allowed by CORS") return res.status(403).json({ error: "origin not allowed" });
  console.error("[decisionos-backend] unhandled error", err);
  res.status(500).json({ error: "internal error" });
});

async function start() {
  if (process.env.DATABASE_URL) {
    await migrate().catch((e) => {
      console.error("[decisionos-backend] failed to migrate schema on startup — continuing, but /api/auth etc. will fail", e.message);
    });
  }
  if (process.env.DATABASE_URL) {
    // Before accepting requests: people deactivated (or whose sessions were cut)
    // must stay locked out across a restart.
    await loadSessionState().catch((e) => console.error("[decisionos-backend] couldn't load revoked sessions", e.message));
  }
  const httpServer = await new Promise((resolve) => {
    const srv = app.listen(PORT, () => {
      console.log(`DecisionOS backend listening on :${srv.address().port}`);
      console.log(`Allowed origins: ${allowedOrigins.join(", ")}`);
      resolve(srv);
    });
  });

  // FASE 8: run the job worker in-process by default (single-instance
  // deployments need nothing extra). Set WORKER_ENABLED=false here and run
  // `npm run worker` as its own process/container once you scale the API
  // out independently of import/refresh throughput.
  if (process.env.DATABASE_URL && process.env.WORKER_ENABLED !== "false") {
    startWorker();
  }

  // P2: automatic Decision -> Action -> Measurement closing. Same
  // in-process-by-default convention as the worker above; the interval
  // is hours, not milliseconds, since this only ever finds work once a
  // decision's measurement_window_days has actually elapsed.
  if (process.env.DATABASE_URL && process.env.MEASUREMENT_LOOP_ENABLED !== "false") {
    startMeasurementLoop();
  }

  return httpServer;
}

// Reused by FASE 11's desktop-main.js (sets DATABASE_URL/PORT/secrets to
// point at an embedded Postgres + a pre-picked free port, then imports
// this module and calls start() itself) — so guard the auto-start the same
// way worker.js does, instead of always running on import.
export { app, start };
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}
