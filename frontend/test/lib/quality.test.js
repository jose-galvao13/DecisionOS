import { describe, it, expect } from "vitest";
import { normalizeQuality, describeIssue } from "../../src/lib/quality";
import { translate } from "../../src/lib/i18n";

// Postgres NUMERIC reaches the browser as a string. This is the exact payload of
// GET /api/datasources/:id/quality that used to render "NaN%" / "undefined% healthy".
const storedReport = {
  score: "100.0",
  issues: [{ severity: "green", code: "valid_revenue_pct", message: "100.0% das receitas válidas", count: 480 }],
  created_at: "2026-09-20T17:42:23.000Z",
};

describe("normalizeQuality", () => {
  it("accepts a score that arrives as a numeric string", () => {
    const q = normalizeQuality(storedReport);
    expect(q.healthPct).toBe(100);
    expect(Number.isNaN(q.healthPct)).toBe(false);
  });

  it("uses the stored stats for the four quality cards", () => {
    const q = normalizeQuality({ ...storedReport, stats: { rows: 480, missingPct: 2.5, duplicates: 3, invalidIds: 4, inconsistent: 1 } });
    expect(q).toMatchObject({ rows: 480, missingPct: "2.5%", duplicates: 3, invalidIds: 4, inconsistent: 1 });
  });

  it("leaves unknown numbers as null (rendered as “—”) for reports saved without stats, instead of inventing zeros", () => {
    const q = normalizeQuality(storedReport);
    expect(q.duplicates).toBeNull();
    expect(q.inconsistent).toBeNull();
    expect(q.missingPct).toBeNull();
    expect(q.rows).toBeNull();
  });

  it("still accepts the shape computed in the browser, and coerces its healthPct", () => {
    expect(normalizeQuality({ healthPct: 97.5, duplicates: 0, rows: 10 }).healthPct).toBe(97.5);
    expect(normalizeQuality({ healthPct: "97.5" }).healthPct).toBe(97.5);
  });

  it("returns null for reports that carry no usable score", () => {
    expect(normalizeQuality(null)).toBeNull();
    expect(normalizeQuality({ score: null, issues: [] })).toBeNull();
    expect(normalizeQuality({ healthPct: "abc" })).toBeNull();
  });
});

describe("describeIssue", () => {
  const tEn = (k, v) => translate("en", k, v);
  const tPt = (k, v) => translate("pt", k, v);

  it("translates the valid-revenue line instead of showing the stored Portuguese sentence", () => {
    const issue = storedReport.issues[0]; // old report: only a PT message + count, no params
    expect(describeIssue(issue, tEn, "en-US")).toBe("100.0% of revenue values are valid");
    expect(describeIssue(issue, tPt, "pt-PT")).toBe("100,0% das receitas são válidas");
  });

  it("uses params when the backend sends them", () => {
    const issue = { code: "valid_revenue_pct", params: { pct: 94.2 }, message: "x", count: 1 };
    expect(describeIssue(issue, tEn, "en-US")).toBe("94.2% of revenue values are valid");
  });

  it("translates count-based issues", () => {
    expect(describeIssue({ code: "invalid_dates", count: 7, message: "7 datas inválidas" }, tEn, "en-US")).toBe("7 invalid dates");
    expect(describeIssue({ code: "missing_customer_id", params: { n: 12 }, message: "" }, tPt, "pt-PT")).toBe("12 transações sem ID de cliente");
  });

  it("recovers the currency list from an older stored message", () => {
    const issue = { code: "mixed_currencies", count: 2, message: "Dataset mistura 2 moedas (EUR, USD) — configure as taxas..." };
    expect(describeIssue(issue, tEn, "en-US")).toContain("2 currencies (EUR, USD)");
  });

  it("falls back to the raw message for codes it doesn't know", () => {
    expect(describeIssue({ code: "something_new", message: "Hello" }, tEn, "en-US")).toBe("Hello");
  });
});
