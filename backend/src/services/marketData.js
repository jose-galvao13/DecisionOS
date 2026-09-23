/* ---------------------------------------------------------------
   MARKET DATA — Parte 2, FASE 3, ponto 3 ("API opcional"). A thin,
   swappable fetchPrices(tickers) interface over whichever provider is
   configured — never called unless the org actually asks for it
   (POST /api/portfolio/price-history/fetch), and never something the
   rest of the app depends on: routes/priceHistory.routes.js falls back
   to the manual/upload path (price_history rows already in the DB) on
   any failure here, per the spec ("se falhar, cai para dados manuais,
   sem partir nada") — see the try/catch per ticker below, which never
   lets one bad ticker or a down provider throw past this module.

   Config (env vars, all optional — with none set, fetchPrices just
   reports every ticker as unavailable and the caller falls back):
     MARKET_DATA_PROVIDER            'stooq' (default, free, no key) |
                                      'alphavantage' | 'none'
     MARKET_DATA_API_KEY_ENCRYPTED   base64 blob from utils/crypto.js's
                                      encryptJSON({ apiKey: '...' }) —
                                      the provider key itself is never
                                      stored in plaintext, same rule as
                                      data_sources.connection_config.
     MARKET_DATA_CACHE_TTL_MS        default 15 minutes (see cache.js)
----------------------------------------------------------------*/
import { decryptJSON } from "../utils/crypto.js";
import { resolveSafeHost } from "../utils/ssrfGuard.js";
import { getCached, setCached } from "./cache.js";

export class MarketDataError extends Error {}

const DEFAULT_PROVIDER = process.env.MARKET_DATA_PROVIDER || "stooq";
const CACHE_TTL_MS = Number(process.env.MARKET_DATA_CACHE_TTL_MS || 15 * 60 * 1000);
const FETCH_TIMEOUT_MS = 10_000;

/** Decrypts the provider API key from its encrypted env var. Returns null
 *  (not a throw) when unset or undecryptable — a provider that needs a
 *  key surfaces that as a normal per-ticker error instead of crashing the
 *  whole batch; providers that don't need a key (stooq) never call this. */
function getApiKey() {
  const blob = process.env.MARKET_DATA_API_KEY_ENCRYPTED;
  if (!blob) return null;
  try {
    const { apiKey } = decryptJSON(blob);
    return apiKey || null;
  } catch {
    return null;
  }
}

// Provider hosts are fixed here, never taken from request input — the
// ssrfGuard check below is defense-in-depth against DNS rebinding on
// *these* fixed hostnames, not a guard against an attacker-supplied URL
// (there is none: `ticker` is interpolated into the query string only).
const PROVIDERS = {
  stooq: {
    needsKey: false,
    buildUrl: (ticker) => `https://stooq.com/q/d/l/?s=${encodeURIComponent(ticker.toLowerCase())}&i=d`,
    // CSV: Date,Open,High,Low,Close,Volume
    parse: (text) => {
      if (/^Exceeded the daily hits limit/i.test(text.trim())) {
        throw new MarketDataError("provider rate limit exceeded");
      }
      const lines = text.trim().split("\n").slice(1);
      const rows = lines
        .map((line) => {
          const parts = line.split(",");
          const date = parts[0];
          const close = Number(parts[4]);
          return date && isFinite(close) ? { data: date, fecho: close } : null;
        })
        .filter(Boolean);
      if (!rows.length) throw new MarketDataError("no data returned for this ticker");
      return rows;
    },
  },
  alphavantage: {
    needsKey: true,
    buildUrl: (ticker, apiKey) =>
      `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${encodeURIComponent(apiKey)}`,
    parse: (text) => {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new MarketDataError("unreadable response from provider");
      }
      const series = json["Time Series (Daily)"];
      if (!series) throw new MarketDataError(json["Note"] || json["Error Message"] || "unexpected response from provider");
      const rows = Object.entries(series).map(([date, day]) => ({ data: date, fecho: Number(day["4. close"]) }));
      if (!rows.length) throw new MarketDataError("no data returned for this ticker");
      return rows;
    },
  },
};

async function fetchOne(ticker, providerName, apiKey) {
  const cacheKey = `marketdata:${providerName}:${ticker}`;
  const cached = getCached(cacheKey);
  if (cached !== undefined) return cached;

  const provider = PROVIDERS[providerName];
  if (!provider) throw new MarketDataError(`unknown provider "${providerName}"`);
  if (provider.needsKey && !apiKey) {
    throw new MarketDataError(`provider "${providerName}" requires MARKET_DATA_API_KEY_ENCRYPTED to be set`);
  }

  const url = provider.buildUrl(ticker, apiKey);
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new MarketDataError("only https provider URLs are allowed");
  await resolveSafeHost(parsed.hostname); // throws if this host resolves somewhere private/internal

  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (e) {
    throw new MarketDataError(`could not reach provider: ${e.message}`);
  }
  if (!res.ok) throw new MarketDataError(`provider returned HTTP ${res.status}`);
  const text = await res.text();
  const rows = provider.parse(text);

  setCached(cacheKey, rows, CACHE_TTL_MS);
  return rows;
}

/**
 * Fetches a daily close-price series per ticker from the configured
 * provider. Never throws: every failure (missing/invalid key, network
 * error, unknown ticker, rate limit, malformed response) is caught per
 * ticker and reported in `errors`, so a caller can import whatever
 * succeeded and fall back to manual data for the rest — "se falhar, cai
 * para dados manuais, sem partir nada".
 *
 * @returns { results: { [ticker]: [{ data, fecho }, ...] }, errors: { [ticker]: message } }
 */
export async function fetchPrices(tickers, { provider = DEFAULT_PROVIDER } = {}) {
  const results = {};
  const errors = {};

  if (!tickers || !tickers.length) return { results, errors };

  if (provider === "none" || !provider) {
    for (const t of tickers) errors[t] = "no market data provider configured (MARKET_DATA_PROVIDER)";
    return { results, errors };
  }

  const apiKey = getApiKey();
  for (const ticker of tickers) {
    try {
      results[ticker] = await fetchOne(ticker, provider, apiKey);
    } catch (e) {
      errors[ticker] = e.message || "failed to fetch prices";
    }
  }
  return { results, errors };
}
