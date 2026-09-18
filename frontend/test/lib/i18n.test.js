import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { STRINGS, translate } from "../../src/lib/i18n";

// Regression guard: `t()` falls back to the raw key, so a missing entry
// used to ship silently as UI text like "settings.general". Every literal
// t("...") key used anywhere in src/ must exist in BOTH languages.
const SRC = path.resolve(__dirname, "../../src");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const usedKeys = new Set();
for (const f of walk(SRC).filter((f) => /\.(jsx?|mjs)$/.test(f) && !f.endsWith("i18n.jsx"))) {
  const src = fs.readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bt\(\s*["'`]([a-zA-Z0-9_.]+)["'`]/g)) usedKeys.add(m[1]);
}

describe("i18n", () => {
  it.each(["pt", "en"])("has every key used in the code (%s)", (lang) => {
    const missing = [...usedKeys].filter((k) => STRINGS[lang][k] === undefined);
    expect(missing).toEqual([]);
  });

  it("PT and EN define the same keys", () => {
    const pt = Object.keys(STRINGS.pt), en = new Set(Object.keys(STRINGS.en));
    expect(pt.filter((k) => !en.has(k))).toEqual([]);
    expect([...en].filter((k) => !(k in STRINGS.pt))).toEqual([]);
  });

  it("interpolates variables", () => {
    expect(translate("en", "data.replaceSuccess", { n: 12 })).toBe("Imported 12 rows.");
  });
});
