/* ---------------------------------------------------------------
   SECURITY PRICES — bulk load of current prices from a spreadsheet.

   The holdings file has no current price (it is a list of what was
   bought), so without this a portfolio of hundreds of tickers would have
   to be priced one PUT /prices at a time before any weight, concentration
   alert or simulation exists. One row = one (ticker, price, currency
   [, date]) quote, written to security_prices exactly like the manual
   entry (same upsert on (org, ticker, date)), with origem 'upload'.

   Pure parsing lives here (no DB) so it can be tested on its own; the
   route in portfolio.routes.js does the writing.

   The sheet is a single table with a header row. Headers are matched by
   name, ignoring case/accents/punctuation, so the file can be an export
   from almost anywhere: Ticker | Preço | Moeda | Data.
     ticker  : ticker, symbol, simbolo, codigo
     price   : preco, preco atual, price, cotacao, fecho, close, ultimo
     currency: moeda, currency, divisa (optional — falls back to the
               currency the ticker is already held in)
     date    : data, date (optional — falls back to today, in SQL)
----------------------------------------------------------------*/
import { parseDate, parseNumber } from "../utils/parse.js";

const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_ISSUES_SHOWN = 20;

const norm = (h) => String(h ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES = {
  ticker: ["ticker", "symbol", "simbolo", "codigo", "acao"],
  price: ["preco", "precoatual", "price", "currentprice", "cotacao", "fecho", "close", "ultimo", "ultimopreco", "last"],
  currency: ["moeda", "currency", "divisa", "ccy"],
  date: ["data", "date", "datacotacao", "dia"],
};

/**
 * @param aoa  worksheet as array-of-arrays (XLSX.utils.sheet_to_json header:1)
 * @param defaultCurrencyByTicker  { [TICKER]: 'EUR' } used when the sheet has no (valid) currency cell
 * @returns { error } when the sheet has no usable header, else
 *   { prices: [{ ticker, preco, moeda, data|null }], skipped, issues: [{ row, reason }], totalRows }
 *   `row` is the 1-based spreadsheet row, so a person can find it.
 */
export function parsePriceRows(aoa, { defaultCurrencyByTicker = {} } = {}) {
  const headerIdx = aoa.findIndex((r) => (r || []).some((c) => c != null && String(c).trim() !== ""));
  if (headerIdx === -1) return { error: "the file is empty" };

  const headers = (aoa[headerIdx] || []).map(norm);
  const col = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, headers.findIndex((h) => names.includes(h))]));
  if (col.ticker === -1 || col.price === -1) {
    return { error: "the first row must be a header with at least a Ticker column and a Preço (price) column; Moeda and Data are optional" };
  }

  const byKey = new Map(); // ticker|date -> price (last row wins, so the upsert never sees a key twice)
  const issues = [];
  let skipped = 0;
  let totalRows = 0;
  const reject = (row, reason) => {
    skipped++;
    if (issues.length < MAX_ISSUES_SHOWN) issues.push({ row, reason });
  };

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i] || [];
    if (!r.some((c) => c != null && String(c).trim() !== "")) continue;
    totalRows++;
    const row = i + 1;

    const ticker = String(r[col.ticker] ?? "").trim().toUpperCase();
    if (!ticker) { reject(row, "missing_ticker"); continue; }
    const preco = parseNumber(r[col.price]);
    if (preco == null || preco <= 0) { reject(row, "invalid_price"); continue; }

    let moeda = col.currency === -1 ? null : String(r[col.currency] ?? "").trim().toUpperCase();
    if (!moeda) moeda = defaultCurrencyByTicker[ticker] || null;
    if (!CURRENCY_RE.test(moeda || "")) { reject(row, "invalid_currency"); continue; }

    let data = null;
    if (col.date !== -1 && r[col.date] != null && String(r[col.date]).trim() !== "") {
      data = parseDate(r[col.date]);
      if (!data) { reject(row, "invalid_date"); continue; }
    }
    byKey.set(`${ticker}|${data ?? ""}`, { ticker, preco, moeda, data });
  }

  return { prices: [...byKey.values()], skipped, issues, totalRows };
}
