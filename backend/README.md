# DecisionOS backend

This pass implements **FASE 1 — Backend Data Foundation** and **FASE 2 —
Analytics** from the roadmap:

- **FASE 1**: PostgreSQL, Organizations, Auth, Users/Roles, Data Sources, a
  server-side Unified Data Model, Excel upload → backend, a PostgreSQL
  connector, column mapping, validation, and a Data Quality score.
- **FASE 2**: `computeAnalytics()` — revenue, profit, margin, product,
  customer, region, channel, growth, forecast, profit-bridge/leakage — is
  now ported to the backend (`src/services/analyticsEngine.js`), reading
  from the database instead of a browser-held transaction array. This also
  finally closes roadmap 🔴 **#2** ("tirar os dados de confiança do
  browser"): `/api/advisor` no longer accepts an `analytics` payload from
  the client at all — it computes it itself from `req.user.orgId`'s own
  data. A client can no longer get Claude to "confirm" fabricated numbers,
  because it's never given the chance to supply any.
- **Data Understanding Engine (new, additive)**: `src/data-understanding/`
  implements the multi-signal semantic detection described in the "Fonte
  vs Significado" architecture note — see its own section below.

**Not done in this pass** (next, per the roadmap's own ordering):
- **Anomaly detection** (listed under FASE 2) isn't built — everything else
  in that bullet list is.
- **FASE 3 (Decision Simulator moved server-side, DCF)**, **FASE 4 (new AI
  tools: `run_dcf`, `get_data_quality`, etc.)**, and **FASE 5 (alerts,
  reports, billing, full audit UI)** are untouched, though the `audit_log`
  table + a `writeAudit()` helper now exist and are already used by every
  FASE-1 mutation (register, user/role changes, data source import/
  connect/refresh) so FASE 5's audit UI has real data to read.
- `analytics-tools.js` (the Claude tool layer — `AI_TOOLS_SCHEMA`/`runTool`)
  is unchanged: it already only reads from whatever `analytics` object it's
  given, so it didn't need to change to start receiving a DB-backed one
  instead of a browser-computed one.

## What's new

```
Excel file          Customer's own PostgreSQL
   │                        │
   ▼                        ▼
POST /api/datasources/excel/preview      POST /api/datasources/postgres/test
   │  (parse, suggest mapping,               → /schemas → /tables → /preview
   │   staged in memory)                          │
   ▼                                              ▼
POST /api/datasources/excel/commit       POST /api/datasources/postgres/commit
   │  (validate, data quality,               (same, + encrypts & stores the
   │   import)                                connection for later refresh)
   ▼                                              │
   └──────────────► Unified Data Model ◄──────────┘
                    (Postgres: transactions +
                     customers/products/regions/channels)
                            │
                            ▼
              GET /api/analytics/full   (the whole engine, FASE 2)
              GET /api/analytics/overview
              GET /api/analytics/revenue/monthly
                            │
                            ▼
              POST /api/advisor   — computes analytics itself from
                                     req.user.orgId, same engine, no
                                     client-supplied numbers accepted
```

```
User → POST /api/auth/register (creates Organization + Owner)
     → POST /api/auth/login    (JWT)
     → every other route requires `Authorization: Bearer <jwt>`;
       req.user.orgId (from the verified token, never the request body)
       is what scopes every query to that tenant.
```

Roles, low → high: `viewer < manager < finance < admin < owner`. Route-level
checks use `requireMinRole()`; e.g. connecting a database is `admin`+,
uploading an Excel file is `manager`+, everyone authenticated can read their
org's overview.

### Excel wizard
`POST /api/datasources/excel/preview` (multipart `file`) parses the sheet,
suggests a column mapping (PT/EN header synonyms), runs a first data-quality
pass, and stages the parsed rows in memory under a `stagingId` (process-local,
30 min TTL — move to Redis before running more than one backend instance).
`POST /api/datasources/excel/commit` takes that `stagingId` + a (possibly
edited) `mapping`, validates, and writes into the unified model.

### PostgreSQL connector
Mirrors the roadmap's wizard exactly: `test` → `schemas` → `tables` →
`preview` (with a suggested mapping) → `commit`, which encrypts the
connection config (AES-256-GCM, `CONFIG_ENCRYPTION_KEY`) and stores it so
`POST /api/datasources/:id/refresh` can re-run the same query later. Schema
and table names are validated against `information_schema` before being
interpolated as quoted identifiers — never taken from the client and put
straight into SQL. MySQL/SQL Server connectors aren't built yet (the
roadmap said Postgres first).

**SSRF guard (roadmap FASE 2 checklist, now implemented):** every connector
call (`test`, `schemas`, `tables`, `preview`, `commit`, `refresh`) resolves
`config.host` itself via `src/utils/ssrfGuard.js` before connecting, and
rejects loopback (`127.0.0.1`, `::1`), private ranges (`10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`), link-local/cloud metadata
(`169.254.0.0/16`, i.e. `169.254.169.254`), and other IANA special-purpose
ranges. It connects using the already-validated IP rather than the original
hostname, which is what stops DNS rebinding (a second DNS answer at connect
time can't matter if there's no second DNS lookup). Set
`PG_CONNECTOR_ALLOW_PRIVATE_HOSTS=true` to disable this for local dev only
(e.g. a Dockerized Postgres) — never set it in production.

### Unified Data Model
`transactions` fact table (`date, customer_id, product_id, region_id,
channel_id, quantity, unit_price, gross_revenue, discount, net_revenue,
cost, gross_profit, currency, source`) plus `customers`/`products` (keyed by
normalized external id) and `regions`/`channels` (keyed by name) dimension
tables — the expanded shape from the roadmap, not the flatter one from the
original frontend model. A refresh/re-import **replaces** that data
source's transactions rather than appending, so refreshing is idempotent.

### Data Quality
Computed at import time (`src/services/dataQuality.js`): missing customer
IDs, invalid dates, missing/invalid revenue, and a 🔴/🟡/🟢 severity per
issue plus a 0–100 score, stored per data source in
`data_quality_reports` and readable via `GET /api/datasources/:id/quality`.
There's no "auto-fix" action yet (the roadmap's `[ Corrigir automaticamente ]`
button) — flagging is done, fixing isn't.

### Data Understanding Engine
`src/data-understanding/` implements the pipeline as separate, ordered
phases — structure and meaning are treated as different problems that
never mix, per the second architecture review:

```
1. STRUCTURE DISCOVERY    structureDiscovery.js — where does the table start?
2. DATA PROFILING         profiling.js           — what type is each column?
3. SEMANTIC UNDERSTANDING semanticTypes.js       — what does it mean?
4. CANDIDATE COMPETITION  \
5. CONFIDENCE             / confidence.js        — margin over runner-up
6. RELATIONSHIP ENGINE    relationships.js       — across tables
7. HUMAN CONFIRMATION     (frontend, not built yet)
8. UNIFIED MODEL          unifiedModel.js (pre-existing)
9. SOURCE ADAPTERS        pgConnector.js today; SQLite/MySQL/SQL Server not built
```

```
structureDiscovery.js
                    Finds where a table actually is inside a raw sheet,
                    BEFORE any profiling/semantics run. A real spreadsheet
                    is rarely "row 1 = header":
                      Empresa XPTO
                      Relatório de vendas 2025

                      Cliente | Produto | Valor
                      João    | PC      | 1200
                      Maria   | Monitor | 300

                      Total   |         | 1500
                    discoverTables(aoa) computes the sheet's "typical row
                    width" (the most common non-empty-cell-count among rows
                    with 2+ cells) and treats the first row that matches
                    that width AND looks like a header (mostly text, no
                    duplicate values) as the real header. Rows before it
                    are titles; a row whose first cell matches
                    total/subtotal/soma/... AND is structurally SHORTER
                    than the table's typical width is excluded as a totals
                    row (the width check matters — it's what stops a
                    legitimate KPI row like "Total Vendas | 12345" in a
                    summary sheet from being wrongly excluded just because
                    of its text). Supports multiple tables per sheet by
                    recursing into whatever's left after each table,
                    capped at 5 per sheet.
profiling.js       column-level facts: primitive type (numeric/date/string/
                    id), null%, unique%, min/max/mean/median, samples.
                    Deliberately doesn't trust JS's lenient Date parsing —
                    V8's `new Date("SKU-1")` actually returns a valid
                    2001-01-01 date, so profiling uses a strict regex check
                    for date-like strings instead of that fallback.
semanticTypes.js    per-column, per-candidate-type score from FOUR signals
                    (header name, expected primitive type, value
                    distribution, cross-column relationship). Vocabulary
                    is split in two layers:
                      DOMAIN_VOCAB  — sales/commerce specifics (REVENUE,
                                      CUSTOMER, PRODUCT_ID, SALARY, ...),
                                      each with real synonyms.
                      GENERIC_VOCAB — MEASURE/ENTITY/CATEGORY/IDENTIFIER/
                                      DATE with NO synonyms, scored on type+
                                      distribution alone. These exist so an
                                      out-of-domain column (Department,
                                      Warehouse, Salary's cousin columns...)
                                      lands on an honest category instead
                                      of UNKNOWN — but see index.js for why
                                      they must never outrank a real domain
                                      match.
confidence.js       AUTO (≥95%) / REVIEW (≥75%) / UNKNOWN thresholds,
                    PLUS a minimum MARGIN over the runner-up candidate to
                    reach AUTO (default 12 points) — "Revenue 97% / Cost
                    41%" auto-maps, "Revenue 97% / Cost 90%" does not,
                    even though both clear the absolute bar, because a
                    close runner-up is itself evidence of ambiguity.
                    UNKNOWN columns get an explicit "couldn't determine
                    this confidently" message instead of a guessed label.
index.js            analyzeDataset(headers, rows): scores the DOMAIN
                    vocabulary first; only consults GENERIC_VOCAB as a
                    fallback when the domain vocabulary genuinely scores
                    UNKNOWN for that column (capped at REVIEW even then —
                    generic classification is never confident enough for
                    AUTO). Also resolves same-type conflicts between
                    columns and never drops unrecognized columns
                    (unknownFields / genericFields are both preserved).
workbook.js         analyzeWorkbook(sheetsAoa): runs the full pipeline
                    (structure → profiling → semantics → confidence) across
                    EVERY sheet of a workbook, and every TABLE within a
                    sheet (a sheet can yield 0, 1, or several tables —
                    structureDiscovery.js decides that first). Flags a
                    table as ambiguous when its sheet name hints at a
                    summary/dashboard, it has too few rows, or most of its
                    columns are unrecognized — the "✓ Vendas ✓ Clientes ?
                    Resumo" UI from the architecture note — and runs
                    relationship detection across every non-ambiguous
                    table, regardless of which sheet it came from.
relationships.js    detectRelationships(datasets): finds cross-dataset
                    keys WITHOUT a declared foreign key. Composite
                    confidence, NOT overlap alone (per the review's
                    Produtos.Nome/Vendas.Marca warning — high overlap can
                    be coincidence, e.g. two small lists of common values):
                      overlap (45%) + category match (20%, e.g. both
                      IDENTIFIER) + cardinality asymmetry (20%, one side
                      must look clearly more "dimension-like" than the
                      other — two equally-unique columns is actually
                      WEAKER evidence, not stronger) + column-name
                      similarity (15%, bonus only, never required). Each
                      relationship ships with the full evidence list, e.g.
                      "100% overlap", "Cliente é ENTITY, Nome é IDENTIFIER",
                      "Nome (Clientes) tem 3/3 valores distintos → dimensão",
                      not just a pass/fail overlap number.
```

Wired in as **the only** mapping engine now — `columnDetection.js` (the
old header-name-only heuristic) has been deleted; `/excel/preview`,
`/excel/analyze`, and `/postgres/preview` all call `analyzeDataset()`.
Both Excel endpoints now read the RAW sheet (`XLSX.utils.sheet_to_json(sheet,
{ header: 1 })`, no assumed header row) and run `structureDiscovery.js`
first — `/excel/preview` picks the largest table found for backward
compatibility; `/excel/analyze` exposes every table found in every sheet,
each staged independently so `/excel/commit` (unchanged) can import any of
them.

**Verified with synthetic data and real generated `.xlsx` files** (test
scripts, not committed):
- The original three differently-named sales formats still all map to the
  same semantic fields; `employees.xlsx`/`inventory.xlsx`-style data still
  comes back with zero UNKNOWN columns (both from the previous pass).
- The exact messy-Excel example from the review — two title rows, a blank
  line, a header, data, another blank line, a "Total | | 1500" row —
  materializes to precisely the 2 real data rows, titles and totals both
  excluded, via a real `.xlsx` round-tripped through `XLSX.read()`, not
  just a hand-built array.
- A totals row directly adjacent to data (no blank line separator, the
  more common real-world layout) is also correctly excluded.
- Multiple tables in one sheet (two header+data blocks separated by a
  blank gap) are both found and parsed independently.
- A "Resumo" sheet containing a legitimate KPI row that happens to start
  with the word "Total" (`"Total Vendas" | 12345`) is correctly kept as
  data — the totals-row check requires the row to be structurally
  SHORTER than the table's typical width, not just text-matched, which is
  what avoids that false positive (caught and fixed while testing).
- `Produtos.Nome` vs `Vendas.Marca` (the review's own overlap-isn't-enough
  example) is still detected as a relationship — it's plausibly real — but
  lands at 73% confidence, not a maxed-out 100%, because the two columns'
  categories don't match (IDENTIFIER vs ENTITY); a same-category case
  scores higher for identical overlap.
- Two real bugs caught and fixed in the previous pass (generic types
  outscoring obvious domain matches; continuous numeric columns scoring as
  identifiers purely from uniqueness) are still holding — reverified this
  pass with the same test scenarios.

**Known calibration gap** (not fixed this pass): a dimension table's own
key columns (e.g. `Clientes.Nome`, one row per customer, so every value is
unique) can lose to `GENERIC_IDENTIFIER` instead of `CUSTOMER`, because
the `CUSTOMER` distribution signal was tuned for a *fact*-table column
where the same customer name repeats across many rows. Doesn't break
relationship detection (both land in the IDENTIFIER/ENTITY key category
either way) but the per-column label on a small, already-deduplicated
dimension sheet can be misleading.

**Not done yet**:
- **Merged cells** aren't specially handled — `structureDiscovery.js`
  works off `sheet_to_json`'s array-of-arrays, where a merged cell's value
  only appears in its top-left position; a header row spanning merged
  cells could misalign. Not tested against a real merged-cell file.
- The header-detection heuristic (typical row width + mostly-text +
  unique values) is still just that — a heuristic. Sheets with highly
  irregular widths per row, or headers that are mostly numeric codes,
  could fool it. No fallback to "ask the user to point at the header row"
  yet.
- **AI fallback layer** (only reached after deterministic/statistical/
  relationship/vocabulary layers, with full column context sent to
  Claude) isn't built; ambiguous columns land in REVIEW/UNKNOWN/generic
  today rather than getting an AI opinion.
- **Learning/feedback loop** (remembering an org's correction of e.g.
  "Amount → Cost" scoped by org+source+sheet context) isn't built.
- **SQLite/MySQL/SQL Server adapters** and a unified `DataSourceAdapter`
  interface (`connect/discover/getSchema/preview/profile/streamRows`
  shared by every connector) aren't built — `pgConnector.js` now feeds the
  same `analyzeDataset()` engine as Excel, but it isn't reshaped onto a
  shared adapter interface, and there's no SQL-side relationship detection
  across tables (only Excel sheets go through `relationships.js` so far).
- The `/excel/analyze` → multi-sheet response shape is new and untested
  against a real frontend — `DecisionOS.jsx` doesn't call it yet and would
  need updating to show the per-sheet confirmation UI and relationship
  list the architecture note mocks up.


### Analytics engine (FASE 2)
`src/services/analyticsEngine.js` is a line-for-line port of
`computeAnalytics()` and its helpers (`groupSum`, `marginLeakage`,
`computeProfitBridge`, `computeCustomerIntelligence`, `linregForecast`,
`computeForecast`, `estimatePriceElasticity`) from `DecisionOS.jsx` — same
math, same output shape (the one `analytics-tools.js`'s `runTool` already
expects), only the input now comes from a SQL join across
`transactions`/`customers`/`products`/`regions`/`channels` for one org
instead of a browser array. `computeAnalyticsForOrg(orgId, filters)` is the
single entry point; `filters` (`period: all|30D|QTD|YTD`, `product`,
`region`, `channel`) match the frontend filter bar's semantics exactly, so
the same filters produce the same numbers whether the browser or Claude
(via `/api/advisor`) is asking.

Rows are capped at 200k per org per call (`ROW_CAP` in that file) — fine
for an MVP-scale dataset, but a growing org's full history should
eventually push filtering/aggregation down into SQL (`GROUP BY`,
`date_trunc`) instead of loading every row into Node and reducing in JS.
Not done in this pass.

### Decision Engine (FASE 3)
```
Analytics Engine -> Decision Engine -> Insights -> Recommendations -> Decisions
```
`src/services/decisionEngine.js` turns one `computeAnalyticsForOrg()`
snapshot into the roadmap's 9 decision primitives — Revenue decline, Margin
deterioration, Customer risk, Product profitability, Pricing opportunity,
Cost leakage, Sales anomaly, Forecast deviation, Working-capital
opportunity. Each decision carries `{ decision, impact, drivers,
recommendation, confidence, evidence, period, affectedEntities }`, exactly
the shape from the roadmap's example. `GET /api/decisions` (same optional
`period`/`product`/`region`/`channel` filters as `/api/analytics/*`) is the
new endpoint; the AI Advisor can also call it directly via the
`get_decisions` tool (FASE 5, below).

A primitive is only emitted when there's real evidence behind it — e.g.
"Customer risk" is skipped entirely if the dataset has no mapped customer
column, "Pricing opportunity" is skipped if demand looks price-elastic
(raising prices would be bad advice, not an opportunity). Confidence is a
function of months of history + transaction volume + signal clarity
(`computeConfidence()`), never a flat number.

Honesty note on **Working-capital opportunity** specifically: real
working-capital signals (DSO, DPO, inventory turns) need invoice-paid-date
and inventory data this unified model doesn't capture yet. Rather than
invent a number we can't compute, this primitive uses the one
working-capital-adjacent thing that *is* measured — revenue concentration
in a small number of customers — and says exactly that, at a capped,
lower confidence. Building the real version is future work once AR/
inventory data sources exist.

Sales anomaly / Forecast deviation share their trend-fitting math with the
`find_anomalies` AI tool via `src/services/anomalyDetection.js`, so a
decision on the feed and an Advisor answer about the same month can't
disagree.

`generateDecisions()` never throws: each detector runs in its own
try/catch and a failure just omits that one decision (logged) rather than
failing the whole feed.

### Simulation Engine (FASE 4)
`src/services/simulationEngine.js` implements the roadmap's "what if?"
scenarios: price change, COGS change, churn change, sales-volume change,
and discontinuing a product — each returning `{ current, scenario, impact,
assumptions, confidence, evidence }` (the "Current → Scenario → Estimated
impact" shape from the roadmap). `POST /api/simulate` exposes all five;
body is `{ type: 'price'|'cost'|'churn'|'volume'|'discontinue_product',
percentChange?, product?, filters? }`.

Four of the five (`price`/`cost`/`churn`/`volume`) are **statistical**
what-ifs: they apply a fitted-or-stated elasticity to the org's totals, and
`assumptions` always names which elasticities were fitted from this
dataset ("estimated") vs. stated ("assumption") — see the same discipline
`analytics-tools.js`'s existing `simulate_price_change` already follows.
`discontinue_product` is different and is labeled as such: `productIntelligence`
already holds that product's real revenue/profit, so "remove it" is an
exact subtraction, not an estimate — the only real assumption is no
reallocation of freed capacity and no cannibalization by remaining
products.

The pre-existing `simulate_price_change` / `simulate_marketing_change` /
`simulate_churn` AI tools in `analytics-tools.js` (and the frontend
behavior built around their output shape) are untouched — this is additive
alongside them, not a replacement, to avoid a shape change breaking
anything already relying on `simulateLevers()`.

### AI Advisor 2.0 (FASE 5)
`analytics-tools.js` now also exposes the Decision Engine and Simulation
Engine directly as tools, on top of the original set:
- `get_decisions` — the full Decision Engine output; the single best tool
  for "why did X happen" / "what should we do" questions, since every
  decision it returns already cites its own evidence and confidence rather
  than making Claude re-derive an answer from lower-level numbers.
- `find_anomalies` — statistically unusual months (revenue or profit),
  shared math with the Decision Engine's Sales anomaly primitive.
- `simulate_cost_change`, `simulate_volume_change`,
  `simulate_discontinue_product` — the new Simulation Engine levers.

Tools the roadmap names that already existed under a different name were
**not duplicated** — `get_revenue` already covers `get_revenue_trend`,
`get_profit_leaks` already covers `get_margin_drivers`, `analyze_products`
already covers `get_product_profitability`, and `forecast_revenue` /
`forecast_profit` already cover `get_forecast`. Giving Claude two
differently-named tools that return the same thing invites it to pick
inconsistently between them, which is worse than one well-named tool doing
the job.

Still open from the roadmap's FASE 5 checklist: nothing here changes
`/api/advisor`'s existing "don't invent metrics" contract (every number
still traces to `computeAnalyticsForOrg`), but there's no explicit
"insufficient data" tool-call path beyond what each tool already returns
(e.g. `{ error: "no customer-level data in this dataset" }`) — a
dedicated `check_data_sufficiency` tool is a reasonable future addition if
the Advisor keeps needing to infer that from individual tool errors.

## Setup

```bash
npm install
cp .env.example .env
# edit .env — see below for what each var is

# create the schema (safe to re-run; also runs automatically on `npm start`
# if DATABASE_URL is set)
npm run migrate

npm start
```

Required env vars (see `.env.example` for the full list with comments):
- `LLM_API_KEY` — for `/api/advisor` and `/api/chat`. Any OpenAI-compatible provider; defaults to Groq (free, Llama). Optional: `LLM_BASE_URL`, `LLM_MODEL`.
- `DATABASE_URL` — this app's own Postgres (not a customer's connected DB).
- `CONFIG_ENCRYPTION_KEY` — 32-byte hex key that encrypts stored connector
  credentials. Generate with
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `JWT_SECRET` — signs login tokens.
- `ALLOWED_ORIGINS` — your frontend origin(s), for CORS.

Server listens on `PORT` (default `8787`). Health check at `GET /health`
(no auth — used for deploy platform health probes).

## Frontend change required

`DecisionOS.jsx` doesn't yet call any of the FASE-1 endpoints (register/
login/data sources) — it still does the local Excel-in-browser onboarding
and sends a client-computed `analytics` snapshot to `/api/advisor`. Wiring
the frontend's onboarding flow to `POST /api/datasources/excel/*` and
adding a login screen is the natural next step, but is a frontend change
outside this backend-only pass. `/api/advisor` and `/api/chat` now require
`Authorization: Bearer <jwt>` — the frontend will need to log in (or you'll
get 401s) before those two endpoints work.

## Deploying

Any Node host works (Render, Railway, Fly.io, a VPS behind nginx, etc.).
Beyond the previous pass's checklist:

- Provision a real Postgres (RDS, Supabase, Render/Railway Postgres, a
  managed VPS instance...) and set `DATABASE_URL` + `PGSSL` accordingly.
- Generate real `CONFIG_ENCRYPTION_KEY` and `JWT_SECRET` values — don't
  reuse the placeholders, and don't reuse either for the other's purpose.
- The rate limiter is still IP-based (30 req/min per process) — now that
  auth exists it could move to per-org quotas, not done in this pass.
- `data_sources.connection_config` holds encrypted customer DB passwords;
  back up `CONFIG_ENCRYPTION_KEY` somewhere separate from the DB backup, or
  a restored DB becomes undecryptable.

## Files

```
src/
  server.js                  Express app: wires auth + org + datasources +
                              analytics routers, plus /api/advisor, /api/chat
  analytics-tools.js          unchanged from the previous pass — the
                              deterministic tool layer Claude calls into
  db/
    schema.sql                organizations, users, data_sources,
                               customers/products/regions/channels,
                               transactions, data_quality_reports, audit_log
    pool.js                   pg Pool + withTransaction helper
    migrate.js                applies schema.sql (idempotent)
  auth/
    password.js                bcrypt hash/verify
    jwt.js                     sign/verify login tokens
    middleware.js               requireAuth, requireMinRole (role hierarchy)
  audit/
    auditLog.js                 writeAudit() — used by every FASE-1 mutation
  data-understanding/
    profiling.js                 column-level facts (type/nulls/unique/stats)
    semanticTypes.js              domain + generic vocabulary, multi-signal
                                  scoring (header+type+distribution+
                                  relationship)
    confidence.js                 AUTO/REVIEW/UNKNOWN + competitor-margin
                                  rule, never guesses when confidence is low
    index.js                     analyzeDataset() orchestrator (single
                                  dataset/sheet)
    workbook.js                   analyzeWorkbook() — all sheets + ambiguous-
                                  sheet flagging + relationship wiring
    relationships.js              cross-dataset key detection without a
                                  declared foreign key
  services/
    columnDetection.js          PT/EN header → field-name heuristic mapping
    staging.js                  in-memory hold between excel preview/commit
    dataQuality.js               issue detection + 0-100 score
    unifiedModel.js              importRows() — the actual DB writer;
                                 getOverview()/getMonthlyRevenue() for
                                 /api/analytics
    pgConnector.js               test/schemas/tables/preview/fetchAllRows
                                 against a CUSTOMER's Postgres
  utils/
    crypto.js                    AES-256-GCM encrypt/decrypt for stored
                                 connector credentials
    parse.js                     parseDate/parseNumber/normalizeKey shared
                                 by both import paths
  routes/
    auth.routes.js                POST /register, /login, GET /me
    organizations.routes.js       GET /, GET/POST /users, PATCH /users/:id/role
    datasources.routes.js         excel + postgres wizards, list, quality,
                                  refresh
    analytics.routes.js           GET /overview, GET /revenue/monthly
```
