/* ---------------------------------------------------------------
   SEED DEMO ORG — FASE 10 ("Sample organization", "Demo dataset").

   Creates a real organization + owner user + a data source with real
   imported transactions, so there's something to explore immediately
   after `npm run migrate` without uploading a file first. Deliberately
   goes through the same importRows() the real Excel/Postgres import
   paths use (services/unifiedModel.js) rather than hand-inserting rows,
   so the sample org exercises the same code the product runs — and so
   the AI Advisor / Decision Engine / analytics cache work on it exactly
   like they would on a customer's own data.

   The transaction shape mirrors frontend/src/lib/demoData.js's
   deterministic demo dataset (same idea: a five-product, five-region
   business with a visible customer-churn and margin-decline story for
   the Decision Engine to find) — kept as a separate, server-side copy
   since it runs here to persist real rows via the backend's own import
   pipeline, not to render an in-browser-only fallback.

   Usage: npm run seed:demo (see package.json)
----------------------------------------------------------------*/
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { importRows } from "../services/unifiedModel.js";
import { assessQuality } from "../services/dataQuality.js";

const DEMO_EMAIL = process.env.SEED_DEMO_EMAIL || "demo@decisionos.app";
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD || "demo12345";
const DEMO_ORG_NAME = "Nortica Demo S.A.";

function seededRandom(seed) {
  let s = seed;
  return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
}

/** Same generator shape/story as frontend/src/lib/demoData.js: 14 months,
 *  5 products/regions/channels, gradual churn + discount creep + one
 *  product's cost ratio drifting up — enough for the Decision Engine,
 *  customer intelligence and profit bridge to all have something to say. */
function generateDemoRows() {
  const rnd = seededRandom(42);
  const products = ["Produto A", "Produto B", "Produto X", "Produto D", "Produto E"];
  const regions = ["Portugal", "Espanha", "França", "Alemanha", "Itália"];
  const channels = ["Direto", "E-commerce", "Revendedor", "Parceiros"];
  const rows = [];
  const start = new Date(Date.UTC(2024, 0, 1));
  let custPool = Array.from({ length: 180 }, (_, i) => `CUST-${1000 + i}`);

  for (let m = 0; m < 14; m++) {
    const monthDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + m, 1));
    const activeCustomers = m < 8 ? custPool : custPool.slice(0, 150 - (m - 8) * 6);
    const newCustomers = m >= 9 ? Array.from({ length: 4 }, (_, i) => `CUST-${9000 + m * 10 + i}`) : [];
    const pool = [...activeCustomers, ...newCustomers];
    const rowsThisMonth = 55 + Math.floor(rnd() * 20);
    for (let i = 0; i < rowsThisMonth; i++) {
      const product = products[Math.floor(rnd() * products.length)];
      const region = regions[Math.floor(rnd() * regions.length)];
      const channel = channels[Math.floor(rnd() * channels.length)];
      const customer = pool[Math.floor(rnd() * pool.length)];
      const day = 1 + Math.floor(rnd() * 27);
      const qty = 1 + Math.floor(rnd() * 12);
      const basePrice = { "Produto A": 92, "Produto B": 61, "Produto X": 140, "Produto D": 45, "Produto E": 77 }[product];
      const unitPrice = basePrice * (0.9 + rnd() * 0.2);
      const grossRevenue = qty * unitPrice;
      const discountRate = 0.02 + (m / 14) * 0.06 + rnd() * 0.02;
      const discount = Math.round(grossRevenue * discountRate);
      const revenue = Math.round(grossRevenue - discount);
      const costRatio = product === "Produto X" ? 0.58 + (m / 14) * 0.22 : 0.55 + rnd() * 0.12;
      const cost = Math.round(revenue * costRatio);
      const date = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), day));
      rows.push({
        Date: date.toISOString().slice(0, 10), Product: product, Region: region, Channel: channel,
        Customer: customer, Quantity: qty, "Unit Price": unitPrice.toFixed(2), Discount: discount, Cost: cost,
      });
    }
  }
  return rows;
}

const MAPPING = {
  date: "Date", product: "Product", region: "Region", channel: "Channel",
  customer: "Customer", quantity: "Quantity", unit_price: "Unit Price", discount: "Discount", cost: "Cost",
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — see .env.example. Run `npm run migrate` first.");
    process.exit(1);
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [DEMO_EMAIL]);
  if (existing.rows.length) {
    console.log(`Demo user ${DEMO_EMAIL} already exists — nothing to do. Delete that user/org first to reseed.`);
    await pool.end();
    return;
  }

  const orgId = randomUUID();
  const userId = randomUUID();
  const dataSourceId = randomUUID();

  await pool.query("INSERT INTO organizations (id, name) VALUES ($1, $2)", [orgId, DEMO_ORG_NAME]);
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  await pool.query(
    `INSERT INTO users (id, org_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,$5,'owner')`,
    [userId, orgId, DEMO_EMAIL, passwordHash, "Demo Owner"]
  );
  await pool.query(
    `INSERT INTO data_sources (id, org_id, name, type, status, column_mapping, created_by)
     VALUES ($1,$2,'Demo dataset','excel','syncing',$3,$4)`,
    [dataSourceId, orgId, JSON.stringify(MAPPING), userId]
  );

  console.log("Generating demo transactions…");
  const rows = generateDemoRows();
  console.log(`Importing ${rows.length} rows through the real import pipeline…`);
  const quality = assessQuality(rows, MAPPING);
  const result = await importRows({ orgId, dataSourceId, rows, mapping: MAPPING });
  await pool.query(
    `INSERT INTO data_quality_reports (id, org_id, data_source_id, score, issues) VALUES ($1,$2,$3,$4,$5)`,
    [randomUUID(), orgId, dataSourceId, quality.score, JSON.stringify(quality.issues)]
  );
  await pool.query("UPDATE data_sources SET status = 'active' WHERE id = $1", [dataSourceId]);

  console.log(`\nDone — imported ${result.imported} rows (${result.skipped} skipped).`);
  console.log(`\nSample organization ready:`);
  console.log(`  Org:      ${DEMO_ORG_NAME}`);
  console.log(`  Email:    ${DEMO_EMAIL}`);
  console.log(`  Password: ${DEMO_PASSWORD}`);
  console.log(`\nLog in with these at the frontend's login screen to explore a fully-populated org.`);
  await pool.end();
}

main().catch((e) => {
  console.error("[seed:demo] failed:", e);
  process.exit(1);
});
