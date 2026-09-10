-- DecisionOS — FASE 1 schema (Backend Data Foundation)
-- IDs are app-generated UUID strings (uuid v4), not pgcrypto/gen_random_uuid(),
-- so this runs on any Postgres (RDS, Supabase, plain VPS) without needing a
-- superuser to CREATE EXTENSION.

CREATE TABLE IF NOT EXISTS organizations (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  -- ISO 4217-style 3-letter code. Per-org fallback (used when a
  -- transaction's own currency can't be determined) AND the target
  -- currency `fx_rates` below convert everything else *into* — see
  -- analyticsEngine.js's convertToDefaultCurrency(). A dataset that
  -- mixes currencies with no rate configured for one of them still
  -- can't be summed correctly; see dataQuality.js's "mixed_currencies"
  -- check, which flags that case rather than pretending a default
  -- alone fixes it.
  default_currency  TEXT NOT NULL DEFAULT 'EUR',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CREATE TABLE IF NOT EXISTS above is a no-op against a database that
-- already has `organizations` from before this column existed — this
-- ALTER is what actually adds it there. Safe to re-run (IF NOT EXISTS).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS default_currency TEXT NOT NULL DEFAULT 'EUR';

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','finance','manager','viewer')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);

-- FX rates — real currency conversion, not just labeling. Manager+
-- sets "1 unit of `currency` = `rate_to_default` units of the org's
-- default_currency" as of a given date; analyticsEngine.js looks up,
-- per transaction, the most recent rate at-or-before that
-- transaction's own date (a simple "spot rate as of" model — this is
-- NOT a full historical FX time series with intraday rates, just
-- enough for "the EUR/USD rate changed when we renegotiated in March"
-- to be representable). A currency with zero rows here, or whose
-- earliest rate is after a transaction's date, is left unconverted —
-- computeAnalyticsForOrg surfaces that explicitly rather than
-- guessing 1:1. Declared after `users` (not right after `organizations`,
-- where it was first written) because `created_by` references it —
-- caught by actually running this against a real Postgres, not just
-- against mocked tests.
CREATE TABLE IF NOT EXISTS fx_rates (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  currency          TEXT NOT NULL, -- the source currency being converted FROM
  rate_to_default   NUMERIC NOT NULL CHECK (rate_to_default > 0),
  effective_date    DATE NOT NULL,
  created_by        TEXT REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, currency, effective_date)
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_org_currency ON fx_rates(org_id, currency, effective_date DESC);

-- One row per connected/imported source (an Excel upload, or a live
-- PostgreSQL/MySQL/SQL Server connection). connection_config holds the
-- (encrypted) connection details for DB sources; NULL for excel sources.
CREATE TABLE IF NOT EXISTS data_sources (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  type               TEXT NOT NULL CHECK (type IN ('excel','postgres','mysql','sqlserver')),
  status             TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','syncing')),
  connection_config  JSONB,           -- encrypted blob, only for db-type sources
  source_schema      TEXT,            -- e.g. 'public' (db sources)
  source_table       TEXT,            -- e.g. 'sales' (db sources)
  column_mapping     JSONB NOT NULL,  -- target field -> source column name
  row_count          INTEGER NOT NULL DEFAULT 0,
  last_sync_at       TIMESTAMPTZ,
  created_by         TEXT REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_sources_org ON data_sources(org_id);

-- Dimensions -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,   -- normalized (trimmed, lowercased) key used for de-dup
  name         TEXT NOT NULL,
  UNIQUE (org_id, external_id)
);

CREATE TABLE IF NOT EXISTS products (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  name         TEXT NOT NULL,
  UNIQUE (org_id, external_id)
);

CREATE TABLE IF NOT EXISTS regions (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS channels (
  id      TEXT PRIMARY KEY,
  org_id  TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  UNIQUE (org_id, name)
);

-- Fact table -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  date           DATE NOT NULL,
  customer_id    TEXT REFERENCES customers(id),
  product_id     TEXT REFERENCES products(id),
  region_id      TEXT REFERENCES regions(id),
  channel_id     TEXT REFERENCES channels(id),
  quantity       NUMERIC NOT NULL DEFAULT 1,
  unit_price     NUMERIC,
  gross_revenue  NUMERIC NOT NULL,
  discount       NUMERIC NOT NULL DEFAULT 0,
  net_revenue    NUMERIC NOT NULL,
  cost           NUMERIC NOT NULL DEFAULT 0,
  gross_profit   NUMERIC NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  source         TEXT,             -- free-text provenance, e.g. original row ref
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_org_date       ON transactions(org_id, date);
CREATE INDEX IF NOT EXISTS idx_tx_data_source    ON transactions(data_source_id);
CREATE INDEX IF NOT EXISTS idx_tx_org_customer   ON transactions(org_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_tx_org_product    ON transactions(org_id, product_id);

CREATE TABLE IF NOT EXISTS data_quality_reports (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_source_id TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  score          NUMERIC NOT NULL,   -- 0-100
  issues         JSONB NOT NULL,     -- [{severity, code, message, count}]
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dq_data_source ON data_quality_reports(data_source_id);

-- Foundation for roadmap #12 (full audit UI is FASE 5) — the table and a
-- write helper exist now so every FASE-1 mutating action already logs.
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id),
  action      TEXT NOT NULL,        -- e.g. 'data_source.created', 'user.role_changed'
  object_type TEXT,
  object_id   TEXT,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, created_at DESC);

-- FASE 8 — background jobs (async imports/refreshes). A Postgres-backed
-- queue rather than Redis/BullMQ: this app is already Postgres-only end to
-- end, one extra table avoids a new piece of infra for the throughput a
-- multi-tenant BI import pipeline actually needs. `FOR UPDATE SKIP LOCKED`
-- in jobQueue.js makes this safe for more than one worker process later.
CREATE TABLE IF NOT EXISTS jobs (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  data_source_id TEXT REFERENCES data_sources(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,     -- 'import_excel' | 'import_postgres' | 'refresh_postgres'
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  stage          TEXT,              -- 'importing' | 'validating' | 'analytics' | 'completed' | ...
  progress       INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  payload        JSONB,             -- job-type-specific input (never raw customer DB passwords — those stay encrypted on data_sources)
  result         JSONB,             -- { imported, skipped, total, dataQuality } on success
  error          TEXT,
  created_by     TEXT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ
);
-- Worker poll query: "give me the oldest queued job" -> partial index keeps
-- this cheap even with years of completed/failed history in the table.
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_org_source ON jobs(org_id, data_source_id, created_at DESC);

-- FASE 8 — a couple of indexes the original FASE 1 schema didn't need yet:
-- data_quality_reports was only ever queried by data_source_id; org-wide
-- quality rollups (Data Quality Center summary) scan by org_id too.
CREATE INDEX IF NOT EXISTS idx_dq_org ON data_quality_reports(org_id, created_at DESC);
-- Covers ORDER BY date DESC (recent-first views) in addition to the
-- existing ascending org_id+date index used by analytics aggregation.
CREATE INDEX IF NOT EXISTS idx_tx_org_date_desc ON transactions(org_id, date DESC);

-- P1 — persisted decisions (the actual product loop: DETECT -> EXPLAIN ->
-- RECOMMEND -> SIMULATE -> DECIDE -> ACT -> MEASURE -> LEARN). Distinct
-- from what GET /api/decisions returns: that endpoint recomputes
-- decisionEngine.js's output fresh on every call from current analytics —
-- useful for "what does the data say right now" but nothing to click
-- "approve" on, no owner, no history of what was actually decided. This
-- table is the record of an actual decision someone made: who owns it,
-- whether it's been approved, what was expected vs. what actually
-- happened. `source_snapshot` freezes the detected-decision and/or
-- simulation-run evidence that justified it at creation time, so a
-- decision's stated rationale doesn't silently change if the underlying
-- data or engine logic changes later — it's a record, not a live query.
CREATE TABLE IF NOT EXISTS decisions (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,   -- the "decision" text — what is being decided
  recommendation    TEXT,
  status            TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed','pending_approval','approved','rejected','in_progress','completed','archived')),
  owner_id          TEXT REFERENCES users(id),      -- who is accountable for acting on this
  created_by        TEXT REFERENCES users(id),
  approved_by       TEXT REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  rejected_reason   TEXT,
  -- Frozen at creation: confidence/evidence from decisionEngine.js and/or
  -- a simulation run (simulationEngine.js) that this decision was based
  -- on, plus the expected impact range being committed to.
  source_type       TEXT,            -- e.g. 'revenue_decline' (decisionEngine type) or 'simulation' or 'manual'
  confidence        INTEGER,         -- 0-100, snapshot at creation time
  source_snapshot   JSONB,           -- { evidence, drivers, simulation, ... } — frozen, not re-derived
  expected_impact   JSONB,           -- { metric, low, high, currency }
  target_date       DATE,            -- when the outcome should be measurable by
  investment_cost   NUMERIC,         -- optional — enables ROI once actual_outcome is recorded
  -- Filled in later, once the real-world result is known (P1 "Expected vs
  -- actual outcome" / "Decision ROI"). NULL until someone measures it.
  actual_outcome    JSONB,           -- { value, currency, measuredAt, notes }
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decisions_org ON decisions(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_org_status ON decisions(org_id, status);
CREATE INDEX IF NOT EXISTS idx_decisions_owner ON decisions(owner_id);

-- P2 — closing the loop (Decision -> ACT -> MEASURE). Added on top of the
-- P1 table above via ALTER (CREATE TABLE IF NOT EXISTS is a no-op on an
-- existing `decisions`), same convention as `default_currency` further up.
--
-- `started_at` + `baseline_metric` are what make an *automatic* comparison
-- possible at all: without capturing what the metric looked like right
-- before the decision was acted on, "observed value 60 days later" is a
-- number with nothing honest to compare it to. `baseline_metric` is a
-- frozen snapshot ({ metric, value, windowDays, from, to, computedAt}),
-- taken once, at the moment the decision moves to in_progress — never
-- recomputed later, for the same "record, not a live query" reason
-- `source_snapshot` is frozen.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS measurement_window_days INTEGER NOT NULL DEFAULT 60;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS baseline_metric JSONB;
-- 'manual' (a person typed a number in) vs 'automatic' (measurementEngine.js
-- computed it from transactions after the window elapsed). Both are real
-- outcomes; this is provenance, not a quality judgement — automatic only
-- fires for metrics it can actually compute (revenue, gross_profit) and is
-- always labelled as such in actual_outcome.notes too.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS outcome_source TEXT CHECK (outcome_source IN ('manual','automatic'));

CREATE INDEX IF NOT EXISTS idx_decisions_measurement_due
  ON decisions(started_at)
  WHERE status = 'in_progress' AND actual_outcome IS NULL;

-- P2 — "Decision -> Action": subtasks with an owner, distinct from the
-- decision's own status (which only tracks the decision's own lifecycle,
-- not who's doing what). A decision can have zero actions (small decisions
-- don't need a checklist) or several; actions do not drive the decision's
-- state machine automatically — a manager still moves the decision to
-- 'completed' explicitly (or recordOutcome does it), same as today.
CREATE TABLE IF NOT EXISTS decision_actions (
  id            TEXT PRIMARY KEY,
  decision_id   TEXT NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  owner_id      TEXT REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','skipped')),
  due_date      DATE,
  completed_at  TIMESTAMPTZ,
  created_by    TEXT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_decision_actions_decision ON decision_actions(decision_id, created_at);
CREATE INDEX IF NOT EXISTS idx_decision_actions_org ON decision_actions(org_id, status);
