import { describe, it, expect } from "vitest";
import { timeAgo } from "../../src/lib/format";
import { generatePassword } from "../../src/lib/passwords";
import { canManageMember, canManageTeam, initialsOf } from "../../src/lib/roles";
import { describeNotification } from "../../src/lib/notifications";
import { translate } from "../../src/lib/i18n";

describe("timeAgo", () => {
  const now = Date.parse("2026-09-21T12:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  it("says 'now' for the last minute, then minutes, hours and days — in the chosen language", () => {
    expect(timeAgo(ago(10_000), "en-US", now)).toBe("now");
    expect(timeAgo(ago(5 * 60_000), "en-US", now)).toBe("5 minutes ago");
    expect(timeAgo(ago(3 * 3_600_000), "en-US", now)).toBe("3 hours ago");
    expect(timeAgo(ago(2 * 86_400_000), "en-US", now)).toBe("2 days ago");
    expect(timeAgo(ago(5 * 60_000), "pt-PT", now)).toMatch(/há 5 minutos/);
  });
  it("falls back to the date after a month, and to '' for junk", () => {
    expect(timeAgo(ago(45 * 86_400_000), "en-US", now)).toMatch(/\d/);
    expect(timeAgo(ago(45 * 86_400_000), "en-US", now)).not.toMatch(/ago/);
    expect(timeAgo("not a date", "en-US", now)).toBe("");
    expect(timeAgo(null, "en-US", now)).toBe("");
  });
});

describe("generatePassword", () => {
  it("is long enough, mixes every class and avoids look-alike characters", () => {
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toHaveLength(14);
      expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/\d/); expect(p).toMatch(/[!@#$%&*?\-_+]/);
      expect(p).not.toMatch(/[0OIl1]/);
    }
  });
  it("is different every time and always within what the server accepts (8..72 bytes)", () => {
    const set = new Set(Array.from({ length: 50 }, () => generatePassword()));
    expect(set.size).toBe(50);
    expect(generatePassword(8)).toHaveLength(8);
    expect(generatePassword(40).length).toBeLessThanOrEqual(72);
  });
});

describe("roles", () => {
  const owner = { id: "o", role: "owner" }, admin = { id: "a", role: "admin" };
  it("mirrors the backend: never yourself or the owner; only an owner manages admins", () => {
    expect(canManageMember(owner, { id: "o", role: "owner" })).toBe(false);
    expect(canManageMember(owner, { id: "x", role: "admin" })).toBe(true);
    expect(canManageMember(admin, { id: "x", role: "admin" })).toBe(false);
    expect(canManageMember(admin, { id: "x", role: "viewer" })).toBe(true);
    expect(canManageMember(admin, { id: "o", role: "owner" })).toBe(false);
    expect(canManageMember(admin, { id: "a", role: "admin" })).toBe(false);
  });
  it("only admins and owners see the team", () => {
    expect(["owner", "admin", "finance", "manager", "viewer"].filter(canManageTeam)).toEqual(["owner", "admin"]);
  });
  it("builds initials from the first two words", () => {
    expect(initialsOf("maria santos costa")).toBe("MS");
    expect(initialsOf("Ana")).toBe("A");
    expect(initialsOf("")).toBe("?");
    expect(initialsOf(undefined)).toBe("?");
  });
});

describe("describeNotification", () => {
  const pt = (k, v) => translate("pt", k, v);
  const en = (k, v) => translate("en", k, v);
  const n = (kind, params = {}) => ({ kind, params });

  it("builds every kind from the dictionary in both languages (no raw keys leak through)", () => {
    const all = [
      n("approval_pending", { title: "Subir preços", by: "Ana" }), n("approval_pending", { title: "Subir preços" }),
      n("decision_approved", { title: "X" }), n("decision_rejected", { title: "X", reason: "sem verba" }), n("decision_rejected", { title: "X" }),
      n("outcome_measured", { title: "X" }), n("import_failed", { name: "a.xlsx", error: "boom" }), n("import_failed", { name: null, error: null }),
      n("low_quality", { name: "a.xlsx", score: 54 }),
      ...["revenue_decline", "margin_deterioration", "customer_risk", "product_profitability", "cost_leakage", "sales_anomaly", "forecast_deviation", "something_new"].map((type) => n("risk", { type, impact: null })),
    ];
    for (const item of all) for (const t of [pt, en]) {
      const { title, body } = describeNotification(item, t, "en-US");
      expect(title).toBeTruthy();
      expect(`${title} ${body}`).not.toMatch(/\bnotif\.[a-z_]+/);
    }
  });

  it("uses the right wording and values", () => {
    expect(describeNotification(n("approval_pending", { title: "Subir preços", by: "Ana" }), pt, "pt-PT")).toEqual({ title: "Decisão à espera de aprovação", body: '"Subir preços" — proposta por Ana' });
    expect(describeNotification(n("low_quality", { name: "a.xlsx", score: 54 }), en, "en-US").body).toContain("a.xlsx scores 54% health");
    expect(describeNotification(n("decision_rejected", { title: "X", reason: "no budget" }), en, "en-US").body).toBe('"X" — reason: no budget');
    expect(describeNotification(n("import_failed", { name: "a.xlsx", error: "file is empty" }), en, "en-US")).toEqual({ title: "Import of a.xlsx failed", body: "file is empty" });
  });

  it("a risk shows its estimated impact when the engine gave one", () => {
    const withImpact = describeNotification(n("risk", { type: "revenue_decline", impact: { value: 12000, currency: "EUR" } }), en, "en-US");
    expect(withImpact).toEqual({ title: "Revenue decline", body: "Estimated impact: €12.0K. See the evidence in Overview." });
    expect(describeNotification(n("risk", { type: "revenue_decline", impact: { value: 5000, currency: "USD" } }), en, "en-US").body).toMatch(/\$5K|\$5\.0K/);
    expect(describeNotification(n("risk", { type: "revenue_decline", impact: null }), en, "en-US").body).toBe("See the evidence and suggested actions in Overview.");
  });
});
