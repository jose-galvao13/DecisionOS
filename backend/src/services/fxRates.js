/* ---------------------------------------------------------------
   FX RATES — real currency conversion, closing the "mixed_currencies"
   gap dataQuality.js has always flagged: until now, a dataset with
   more than one currency just got summed as raw numbers with a red
   warning. This lets an org tell DecisionOS the actual rate for each
   non-default currency, and analyticsEngine.js uses it to convert
   before summing.
----------------------------------------------------------------*/
import { randomUUID } from "crypto";
import { pool } from "../db/pool.js";
import { writeAudit } from "../audit/auditLog.js";

export class FxRateError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const CURRENCY_RE = /^[A-Z]{3}$/;

export async function setRate(orgId, userId, { currency, rateToDefault, effectiveDate }) {
  const code = String(currency || "").trim().toUpperCase();
  if (!CURRENCY_RE.test(code)) throw new FxRateError("currency must be a 3-letter ISO code, e.g. 'USD'");
  const rate = Number(rateToDefault);
  if (!Number.isFinite(rate) || rate <= 0) throw new FxRateError("rateToDefault must be a positive number");
  const date = effectiveDate || new Date().toISOString().slice(0, 10);
  if (Number.isNaN(new Date(date).getTime())) throw new FxRateError("effectiveDate must be a valid date");

  const { rows: orgRows } = await pool.query(`SELECT default_currency FROM organizations WHERE id = $1`, [orgId]);
  if (!orgRows.length) throw new FxRateError("organization not found", 404);
  if (code === orgRows[0].default_currency) {
    throw new FxRateError(`this org's default currency is already ${code} — no rate needed to convert it to itself`);
  }

  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO fx_rates (id, org_id, currency, rate_to_default, effective_date, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (org_id, currency, effective_date)
       DO UPDATE SET rate_to_default = EXCLUDED.rate_to_default, created_by = EXCLUDED.created_by
     RETURNING *`,
    [id, orgId, code, rate, date, userId]
  );
  await writeAudit({ orgId, userId, action: "fx_rate.set", objectType: "fx_rate", objectId: rows[0].id, after: rows[0] });
  return rows[0];
}

export async function listRates(orgId) {
  const { rows } = await pool.query(
    `SELECT * FROM fx_rates WHERE org_id = $1 ORDER BY currency ASC, effective_date DESC`,
    [orgId]
  );
  return rows;
}

export async function deleteRate(orgId, id, userId) {
  const { rows } = await pool.query(`DELETE FROM fx_rates WHERE id = $1 AND org_id = $2 RETURNING *`, [id, orgId]);
  if (!rows.length) throw new FxRateError("rate not found", 404);
  await writeAudit({ orgId, userId, action: "fx_rate.deleted", objectType: "fx_rate", objectId: id, before: rows[0] });
  return rows[0];
}

/** Builds a { [currency]: [{ effectiveDate, rate }, ...] } lookup, rates
 *  sorted oldest-first per currency, for convertToDefaultCurrency() below
 *  to binary/linear-scan against a transaction's own date. Kept as a
 *  plain function (not a class) so analyticsEngine.js can load it once
 *  per computeAnalyticsForOrg() call and reuse it across every
 *  transaction instead of querying per row. */
export function buildRateIndex(rateRows) {
  const index = {};
  for (const r of rateRows) {
    if (!index[r.currency]) index[r.currency] = [];
    index[r.currency].push({ effectiveDate: new Date(r.effective_date), rate: Number(r.rate_to_default) });
  }
  for (const currency of Object.keys(index)) index[currency].sort((a, b) => a.effectiveDate - b.effectiveDate);
  return index;
}

/** The rate in effect for `currency` as of `date`: the most recent
 *  effective_date at or before `date`. Falls back to the *earliest*
 *  known rate if `date` predates every rate on file (better than
 *  refusing to convert a transaction just because it's older than
 *  when someone first entered a rate). Returns null if there is no
 *  rate for this currency at all — callers must treat that as
 *  "can't convert this one", not as "rate is 1".
 */
export function rateAsOf(rateIndex, currency, date) {
  const series = rateIndex[currency];
  if (!series || !series.length) return null;
  let best = series[0];
  for (const point of series) {
    if (point.effectiveDate <= date) best = point;
    else break;
  }
  return best.rate;
}
