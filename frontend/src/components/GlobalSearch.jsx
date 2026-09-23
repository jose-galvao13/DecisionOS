import React, { useState, useMemo, useRef, useEffect, useId } from "react";
import { Search, X, Package, MapPin, Radio, FileSpreadsheet, CornerDownLeft } from "lucide-react";
import { C, tint } from "../lib/theme";
import { useLang } from "../lib/i18n";

/* ---------------------------------------------------------------
   GLOBAL SEARCH — the search box in the header.

   What it finds:
   - Pages       (Overview, Profit Intelligence, Settings, ...)
   - Products    (from the loaded analytics)  → applies the product filter
   - Regions     (idem)                        → applies the region filter
   - Channels    (idem)                        → applies the channel filter
   - Files       (uploaded data sources)       → opens the Data page

   Matching ignores case and accents ("visao" finds "Visão geral"),
   every word you type must match, and results are ranked: starts-with
   beats word-starts-with beats contains.

   Keyboard: Ctrl/Cmd+K focuses the box, ↑/↓ move, Enter opens, Esc closes.
----------------------------------------------------------------*/

// Extra words per page so people find things by what they *mean*, not only by
// the exact title ("margem" → Profit Intelligence, "upload" → Data).
const PAGE_KEYWORDS = {
  overview: "inicio home resumo dashboard kpi painel",
  bi: "vendas sales receita revenue graficos charts analise analytics",
  profit: "lucro margem margin fugas leakage rentabilidade custos costs",
  customers: "clientes churn retencao retention",
  invest: "investimento dcf valuation avaliacao roi",
  portfolio: "acoes carteira risco stocks investimentos holdings bolsa titulos",
  sim: "simulacao simulation cenarios scenarios what-if",
  advisor: "ia ai assistente assistant recomendacao recommendation chat",
  decisionLog: "decisoes decisions historico history registo log",
  data: "ficheiros files excel csv upload carregar importar import fontes sources",
  dataQuality: "qualidade quality erros errors duplicados duplicates",
  products: "produtos artigos items catalogo catalog",
  reports: "relatorios exportar export pdf",
  settings: "definicoes configuracoes config preferencias preferences",
};

// Lower-cases and strips accents *one character at a time*, so the folded
// string has exactly the same length as the original. That lets us map a
// match position in the folded text straight back onto the original for
// highlighting.
function fold(str) {
  let out = "";
  for (const ch of String(str ?? "")) {
    const f = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    out += f.length === 1 ? f : ch;
  }
  return out;
}

const tokenize = (q) => fold(q).split(/\s+/).filter(Boolean);

/** Lower is better; Infinity = no match. Every token must be found. */
function scoreText(text, tokens) {
  const f = fold(text);
  let total = 0;
  for (const tk of tokens) {
    const i = f.indexOf(tk);
    if (i === -1) return Infinity;
    if (i === 0) total += 0;
    else if (/[\s\-_/.,(]/.test(f[i - 1])) total += 1;
    else total += 2;
  }
  return total;
}

/** Wraps the parts of `text` matching any token in a <mark>-like span. */
function Highlight({ text, tokens }) {
  const f = fold(text);
  const flags = new Array(f.length).fill(false);
  for (const tk of tokens) {
    let from = 0;
    for (;;) {
      const i = f.indexOf(tk, from);
      if (i === -1) break;
      for (let k = i; k < i + tk.length; k++) flags[k] = true;
      from = i + tk.length;
    }
  }
  const chars = [...String(text)];
  // `chars` and `flags` only line up when nothing is a surrogate pair; if the
  // lengths differ (emoji in a file name, say) skip highlighting rather than misplace it.
  if (chars.length !== flags.length) return <>{text}</>;
  const parts = [];
  let buf = "", cur = false;
  chars.forEach((ch, i) => {
    if (flags[i] !== cur && buf) { parts.push([cur, buf]); buf = ""; }
    cur = flags[i]; buf += ch;
  });
  if (buf) parts.push([cur, buf]);
  return (
    <>
      {parts.map(([hit, s], i) =>
        hit ? <span key={i} style={{ color: C.blue, fontWeight: 700 }}>{s}</span> : <React.Fragment key={i}>{s}</React.Fragment>
      )}
    </>
  );
}

const MAX_PER_GROUP = 5;
const MAX_PAGES_WHEN_EMPTY = 8;

/**
 * props:
 *  - pages:      [{ id, key, icon }]  navigation entries (label = t(key))
 *  - analytics:  the loaded analytics (byProduct / byRegion / byChannel)
 *  - sources:    uploaded data sources [{ id, name, ... }]
 *  - onSelect:   ({ type: "page"|"filter"|"source", ... }) => void
 */
function GlobalSearch({ pages = [], analytics, sources = [], onSelect }) {
  const { t, lang } = useLang();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const rootRef = useRef(null);
  const activeRef = useRef(null);
  const listId = useId();

  const tokens = useMemo(() => tokenize(query), [query]);

  // Every searchable thing, built once per data change (not per keystroke).
  const index = useMemo(() => {
    const uniq = (arr) => [...new Set(arr.filter((v) => v && String(v).trim()))];
    const products = uniq((analytics?.byProduct || []).map((p) => p.product));
    const regions = uniq((analytics?.byRegion || []).map((r) => r.region));
    const channels = uniq((analytics?.byChannel || []).map((c) => c.channel));
    return {
      pages: pages.map((p) => ({
        group: "pages", id: `page:${p.id}`, label: t(p.key), icon: p.icon,
        extra: PAGE_KEYWORDS[p.id] || "", action: { type: "page", id: p.id },
      })),
      products: products.map((v) => ({ group: "products", id: `product:${v}`, label: v, icon: Package, hint: t("dim.product"), action: { type: "filter", dim: "product", value: v } })),
      regions: regions.map((v) => ({ group: "regions", id: `region:${v}`, label: v, icon: MapPin, hint: t("dim.region"), action: { type: "filter", dim: "region", value: v } })),
      channels: channels.map((v) => ({ group: "channels", id: `channel:${v}`, label: v, icon: Radio, hint: t("dim.channel"), action: { type: "filter", dim: "channel", value: v } })),
      files: (sources || []).filter((s) => s?.name).map((s) => ({ group: "files", id: `file:${s.id}`, label: s.name, icon: FileSpreadsheet, hint: t("search.group.files"), action: { type: "source", id: s.id } })),
    };
    // `t` is a new function on every render, so key the memo on the language instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, analytics, sources, lang]);

  const groups = useMemo(() => {
    const order = ["pages", "products", "regions", "channels", "files"];
    if (!tokens.length) {
      // Nothing typed yet: offer the pages as a quick jump list.
      return index.pages.length ? [{ name: "pages", items: index.pages.slice(0, MAX_PAGES_WHEN_EMPTY) }] : [];
    }
    return order
      .map((name) => {
        const items = index[name]
          .map((it) => {
            // A hit on the label counts fully; a hit only on hidden keywords ranks lower.
            const s = scoreText(it.label, tokens);
            const sExtra = it.extra ? scoreText(`${it.label} ${it.extra}`, tokens) + 3 : Infinity;
            return { it, s: Math.min(s, sExtra) };
          })
          .filter((x) => x.s !== Infinity)
          .sort((a, b) => a.s - b.s || a.it.label.localeCompare(b.it.label))
          .slice(0, MAX_PER_GROUP)
          .map((x) => x.it);
        return { name, items };
      })
      .filter((g) => g.items.length);
  }, [index, tokens]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  // New results → highlight the first one again.
  useEffect(() => { setActive(0); }, [query, flat.length]);

  useEffect(() => {
    if (open) activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  // Click outside closes the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Ctrl/Cmd+K from anywhere jumps to the search box.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const choose = (item) => {
    if (!item) return;
    onSelect?.(item.action);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const onKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (flat.length) setActive((a) => (a + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((a) => (a - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      if (open && flat[active]) { e.preventDefault(); choose(flat[active]); }
    } else if (e.key === "Escape") {
      if (query) setQuery(""); else { setOpen(false); inputRef.current?.blur(); }
    }
  };

  const showPanel = open && (groups.length > 0 || tokens.length > 0);
  const activeId = flat[active] ? `${listId}-${active}` : undefined;
  let runningIndex = -1;

  return (
    <div ref={rootRef} className="relative" style={{ width: 320 }}>
      <div
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg"
        style={{ background: C.greyBg, border: `1px solid ${open ? C.blue : "transparent"}` }}
      >
        <Search size={15} color={C.textMuted} aria-hidden="true" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={t("search.placeholder")}
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={t("search.placeholder")}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="flex-1 min-w-0 bg-transparent outline-none text-sm"
          style={{ color: C.charcoal }}
        />
        {query ? (
          <button
            type="button"
            aria-label={t("search.clear")}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setQuery(""); inputRef.current?.focus(); }}
            className="flex items-center justify-center rounded"
            style={{ color: C.textMuted }}
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="text-[10px] px-1.5 py-0.5 rounded" style={{ color: C.textMuted, border: `1px solid ${C.greyBorder}` }} aria-hidden="true">
            {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "") ? "⌘K" : "Ctrl K"}
          </kbd>
        )}
      </div>

      {showPanel && (
        <div
          id={listId}
          role="listbox"
          aria-label={t("search.placeholder")}
          className="absolute left-0 right-0 mt-2 rounded-xl overflow-y-auto z-50"
          style={{ background: C.surface, border: `1px solid ${C.greyBorder}`, boxShadow: "0 12px 32px rgba(10,21,38,0.16)", maxHeight: 420, minWidth: 320 }}
        >
          {flat.length === 0 ? (
            <div className="px-4 py-6 text-sm text-center" style={{ color: C.textMuted }}>
              {t("search.noResults", { q: query.trim() })}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.name} role="group" aria-label={t(`search.group.${g.name}`)}>
                <div className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: C.textMuted }}>
                  {t(`search.group.${g.name}`)}
                </div>
                {g.items.map((item) => {
                  runningIndex += 1;
                  const idx = runningIndex;
                  const isActive = idx === active;
                  const Icon = item.icon;
                  return (
                    <div
                      key={item.id}
                      id={`${listId}-${idx}`}
                      ref={isActive ? activeRef : null}
                      role="option"
                      aria-label={item.hint ? `${item.label} — ${item.hint}` : item.label}
                      aria-selected={isActive}
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => choose(item)}
                      className="mx-2 px-2.5 py-2 rounded-lg flex items-center gap-2.5 cursor-pointer text-sm"
                      style={{ background: isActive ? tint(C.blue, 12) : "transparent", color: C.charcoal }}
                    >
                      {Icon && <Icon size={15} color={isActive ? C.blue : C.textMuted} aria-hidden="true" />}
                      <span className="flex-1 min-w-0 truncate"><Highlight text={item.label} tokens={tokens} /></span>
                      {item.hint && <span className="text-xs shrink-0" style={{ color: C.textMuted }}>{item.hint}</span>}
                      {isActive && <CornerDownLeft size={13} color={C.textMuted} aria-hidden="true" />}
                    </div>
                  );
                })}
              </div>
            ))
          )}
          <div className="h-2" />
        </div>
      )}
    </div>
  );
}

export default GlobalSearch;
export { fold, scoreText, tokenize };
