import { describe, it, expect } from "vitest";
import { parseDate, parseNumber, normalizeKey } from "../../src/utils/parse.js";

describe("parseDate", () => {
  it("parses a JS Date object", () => {
    expect(parseDate(new Date(Date.UTC(2024, 0, 15)))).toBe("2024-01-15");
  });
  it("parses an Excel serial number", () => {
    // 45000 -> 2023-03-15 in Excel's 1900 date system
    expect(parseDate(45000)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("parses dd/mm/yyyy (PT format)", () => {
    expect(parseDate("15/01/2024")).toBe("2024-01-15");
  });
  it("parses dd-mm-yy with 2-digit year", () => {
    expect(parseDate("05-06-24")).toBe("2024-06-05");
  });
  it("returns null for empty/garbage input", () => {
    expect(parseDate(null)).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });
});

describe("parseNumber", () => {
  it("parses a plain number", () => {
    expect(parseNumber(42)).toBe(42);
  });
  it("strips currency symbols", () => {
    expect(parseNumber("€1234.56")).toBeCloseTo(1234.56);
  });
  it("handles EU-style thousands/decimal (1.234,56)", () => {
    expect(parseNumber("1.234,56")).toBeCloseTo(1234.56);
  });
  it("handles US-style thousands/decimal (1,234.56)", () => {
    expect(parseNumber("1,234.56")).toBeCloseTo(1234.56);
  });
  it("returns null for non-numeric strings", () => {
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber(null)).toBeNull();
  });
});

describe("normalizeKey", () => {
  it("trims and lowercases", () => {
    expect(normalizeKey("  Acme Ltd  ")).toBe("acme ltd");
  });
  it("returns null for empty/nullish values", () => {
    expect(normalizeKey(null)).toBeNull();
    expect(normalizeKey("   ")).toBeNull();
  });
  it("treats differently-cased/whitespaced values as the same key", () => {
    expect(normalizeKey("Acme Ltd")).toBe(normalizeKey(" acme ltd "));
  });
});
