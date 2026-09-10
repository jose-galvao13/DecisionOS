import { describe, it, expect } from "vitest";
import { computeAnalytics } from "../../src/services/analyticsEngine.js";
import { AI_TOOLS_SCHEMA, runTool } from "../../src/analytics-tools.js";

function tx({ date, product = "Widget", region = "North", channel = "Online", customer = "Acme", unitPrice = 100, cost = 40 }) {
  const revenue = unitPrice;
  return { date: new Date(date), product, region, channel, customer, quantity: 1, unitPrice, discount: 0, revenue, cost, profit: revenue - cost };
}

function sampleAnalytics() {
  const txs = [];
  for (let m = 1; m <= 5; m++) {
    for (let i = 0; i < 4; i++) txs.push(tx({ date: `2024-0${m}-1${i}`, customer: `Customer ${i}` }));
  }
  return computeAnalytics(txs);
}

describe("AI_TOOLS_SCHEMA — conformity", () => {
  it("every tool has a name, description, and a valid Anthropic-style input_schema", () => {
    expect(AI_TOOLS_SCHEMA.length).toBeGreaterThan(0);
    for (const tool of AI_TOOLS_SCHEMA) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(10); // Claude needs enough context to pick the right tool
      expect(tool.input_schema.type).toBe("object");
      expect(typeof tool.input_schema.properties).toBe("object");
    }
  });

  it("has no duplicate tool names", () => {
    const names = AI_TOOLS_SCHEMA.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool with 'required' params lists only params that exist in properties", () => {
    for (const tool of AI_TOOLS_SCHEMA) {
      for (const req of tool.input_schema.required || []) {
        expect(tool.input_schema.properties).toHaveProperty(req);
      }
    }
  });
});

describe("runTool — dispatch", () => {
  it("get_company_overview reads straight from analytics.totals, never invents a number", () => {
    const analytics = sampleAnalytics();
    const result = runTool("get_company_overview", {}, { analytics });
    expect(result.revenue).toBe(Math.round(analytics.totals.revenue));
    expect(result.transactions).toBe(analytics.count);
  });

  it("simulate_price_change uses simulateLevers and always labels the elasticity source", () => {
    const analytics = sampleAnalytics();
    const result = runTool("simulate_price_change", { percentChange: 5 }, { analytics });
    expect(typeof result.dRevenue).toBe("number");
    expect(typeof result.dProfit).toBe("number");
    expect(["estimated", "assumption"]).toContain(result.assumptions.priceElasticity.source);
  });

  it("simulate_discontinue_product surfaces the engine's error for an unknown product rather than throwing", () => {
    const analytics = sampleAnalytics();
    const result = runTool("simulate_discontinue_product", { product: "Nonexistent" }, { analytics });
    expect(result.error).toBeTruthy();
  });

  it("get_decisions returns the Decision Engine's output for this analytics snapshot", () => {
    const analytics = sampleAnalytics();
    const result = runTool("get_decisions", {}, { analytics });
    expect(Array.isArray(result.decisions)).toBe(true);
  });

  it("an unknown tool name fails gracefully instead of crashing the advisor turn", () => {
    const analytics = sampleAnalytics();
    const result = runTool("not_a_real_tool", {}, { analytics });
    expect(result.error).toBeTruthy();
  });
});
