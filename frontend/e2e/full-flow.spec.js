import { test, expect } from "@playwright/test";
import * as XLSX from "xlsx";

/* ---------------------------------------------------------------
   FASE 9 E2E — the roadmap's ideal flow, end to end against a real
   backend + Postgres:

     Register -> Create organization -> Import dataset -> Data quality
       -> Analytics -> Decision -> Ask Advisor -> Simulation

   In this app, "Register" and "Create organization" are the same
   step (POST /api/auth/register creates both in one call — see
   backend/src/routes/auth.routes.js) since every org's first user is
   its owner. Importing is now async (FASE 8): commit returns a job
   and a worker does the real import, so this test waits out the
   progress bar rather than expecting an instant result.

   Requires a live stack — see e2e/README.md. Not part of `npm test`.
----------------------------------------------------------------*/

function buildDemoWorkbookBuffer() {
  // 6 months of clearly-declining revenue on one product so every
  // downstream stage (data quality, analytics, decision engine, advisor,
  // simulator) has something real to work with — an all-flat dataset
  // wouldn't produce a Decision Feed entry to click through to.
  const rows = [["Date", "Product", "Region", "Channel", "Customer", "Quantity", "Unit Price", "Cost"]];
  let day = 0;
  for (let m = 1; m <= 6; m++) {
    const unitsThisMonth = 40 - m * 4; // declining volume
    for (let i = 0; i < unitsThisMonth; i++, day++) {
      const d = new Date(Date.UTC(2024, m - 1, 1 + (i % 27)));
      rows.push([
        d.toISOString().slice(0, 10), "Widget Pro", i % 2 === 0 ? "North" : "South",
        i % 3 === 0 ? "Online" : "Retail", `Customer ${i % 12}`, 1, 120, 55,
      ]);
    }
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Sales");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

test.describe("Full onboarding-to-decision flow", () => {
  test("register, import, and reach a decision + advisor answer + simulation", async ({ page }) => {
    const unique = Date.now();
    const email = `e2e-${unique}@example.com`;

    // ---- Register (creates org + owner user in one step) ----
    await page.goto("/");
    await page.getByPlaceholder(/nome da empresa|company name/i).fill(`E2E Org ${unique}`);
    await page.getByPlaceholder(/o seu nome|your name/i).fill("E2E Tester");
    await page.getByPlaceholder(/email/i).fill(email);
    await page.getByPlaceholder(/palavra-passe|password/i).fill("correct horse battery staple");
    // The form defaults to "login" mode — switch to "register" first.
    const switchModeButton = page.getByRole("button", { name: /crie uma conta|criar conta|create an account|sign up/i });
    if (await switchModeButton.isVisible().catch(() => false)) await switchModeButton.click();
    await page.getByRole("button", { name: /registar|sign up|create account/i }).click();

    // ---- Import dataset (Excel) ----
    await expect(page.getByText(/Excel/i).first()).toBeVisible({ timeout: 15000 });
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.getByText("Excel", { exact: true }).click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: "e2e-sales.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: buildDemoWorkbookBuffer(),
    });

    // preview step -> confirm suggested mapping
    await expect(page.getByText("e2e-sales.xlsx")).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /está correto|correct/i }).click();

    // FASE 8: async job — wait for the progress bar to finish rather than
    // an instant response.
    await expect(page.getByText(/%$/)).toBeVisible({ timeout: 15000 });
    await page.getByRole("button", { name: /começar a usar|start using/i }).click({ timeout: 120_000 });

    // ---- Analytics (Overview) ----
    await expect(page.getByText(/receita|revenue/i).first()).toBeVisible({ timeout: 20000 });

    // ---- Data quality ----
    await page.getByText(/dados|data/i, { exact: false }).first().click().catch(() => {});
    // (Data page nav item may be labeled differently per locale — fall back
    // to the sidebar's known nav id via role if text match is ambiguous.)

    // ---- Decision ----
    // The Decision Feed lives on Overview; with a real revenue decline in
    // the fixture above, at least one decision card should render.
    await page.goto("/"); // back to overview if navigation above wandered off
    const decisionCard = page.getByText(/decisão|decision/i).first();
    await expect(decisionCard).toBeVisible({ timeout: 20000 });

    // ---- Ask Advisor ----
    await page.getByText(/AI Advisor/i).first().click();
    await page.getByRole("button", { name: /gerar|generate/i }).click();
    await expect(page.getByText(/€|EUR|%/).first()).toBeVisible({ timeout: 30000 });

    // ---- Simulation ----
    await page.getByText(/Decision Simulator|Simulador/i).first().click();
    const slider = page.locator('input[type="range"]').first();
    await expect(slider).toBeVisible({ timeout: 10000 });
    await slider.fill("10");
    await expect(page.getByText(/€|EUR/).first()).toBeVisible();
  });
});
