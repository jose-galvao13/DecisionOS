import React from "react";
import { Wrench, ShieldAlert, KeyRound, Loader2, CheckCircle2, Coins } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { Card, SectionTitle, useToast } from "../../components/ui";
import LangSwitch from "../../components/LangSwitch";
import { isDesktopApp, hasAnthropicKey, saveAnthropicKey } from "../../lib/desktopBridge";
import { apiFetch } from "../../api/client";

// Org-level fallback currency (see backend/src/routes/organizations.routes.js
// and unifiedModel.js): used for any transaction whose source data doesn't
// carry its own currency column. This does not convert existing data or
// change already-imported transactions — it only affects the label applied
// to future imports that don't map a currency column themselves.
const SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CHF", "BRL", "JPY", "CAD", "AUD"];

function OrgCurrencyCard() {
  const { t } = useLang();
  const toast = useToast();
  const [loading, setLoading] = React.useState(true);
  const [currency, setCurrency] = React.useState("EUR");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    apiFetch("/api/org")
      .then((org) => setCurrency(org.default_currency || "EUR"))
      .catch((e) => setError(e.message || "Could not load organization settings"))
      .finally(() => setLoading(false));
  }, []);

  const save = async (next) => {
    setSaving(true);
    setError("");
    try {
      const org = await apiFetch("/api/org", { method: "PATCH", body: { defaultCurrency: next } });
      setCurrency(org.default_currency);
      toast.success(t("settings.currencySaved") || "Default currency updated.");
    } catch (e) {
      setError(e.message || "Could not save");
      toast.error(e.message || "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-3">
        <Coins size={15} color={C.blue} />
        <div className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("settings.currency") || "Default currency"}</div>
      </div>
      <p className="text-sm mb-3" style={{ color: C.textMuted }}>
        {t("settings.currencyDesc") ||
          "Used as a fallback label for any imported transaction that doesn't specify its own currency, and as the target currency FX rates below convert everything else into."}
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> {t("dq.loading") || "Loading…"}</div>
      ) : (
        <div className="flex items-center gap-2">
          <select
            value={currency}
            disabled={saving}
            onChange={(e) => save(e.target.value)}
            className="px-3 py-2 rounded-lg text-sm"
            style={{ border: `1px solid ${C.greyBorder}` }}
          >
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {saving && <Loader2 size={14} className="animate-spin" color={C.textMuted} />}
        </div>
      )}
      {error && <div className="text-sm mt-2" style={{ color: C.red }}>{error}</div>}
    </Card>
  );
}

/** P2 — real currency conversion (backend: fxRates.js). Lets a manager
 *  tell DecisionOS "1 USD = 0.9 EUR as of 1 Jan 2024" so analyticsEngine.js
 *  can actually convert instead of just labeling. */
function FxRatesCard() {
  const toast = useToast();
  const [rates, setRates] = React.useState(null); // null = loading
  const [currency, setCurrency] = React.useState("USD");
  const [rateToDefault, setRateToDefault] = React.useState("");
  const [effectiveDate, setEffectiveDate] = React.useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(() => {
    apiFetch("/api/org/fx-rates").then(setRates).catch((e) => toast.error(e.message));
  }, [toast]);

  React.useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    const rate = Number(rateToDefault);
    if (!Number.isFinite(rate) || rate <= 0) return toast.error("Rate must be a positive number.");
    setSaving(true);
    try {
      await apiFetch("/api/org/fx-rates", { method: "POST", body: { currency, rateToDefault: rate, effectiveDate } });
      setRateToDefault("");
      load();
      toast.success(`Rate for ${currency.toUpperCase()} saved.`);
    } catch (e2) { toast.error(e2.message); } finally { setSaving(false); }
  };

  const remove = async (id) => {
    try {
      await apiFetch(`/api/org/fx-rates/${id}`, { method: "DELETE" });
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-3">
        <Coins size={15} color={C.blue} />
        <div className="text-sm font-semibold" style={{ color: C.charcoal }}>Exchange rates</div>
      </div>
      <p className="text-sm mb-3" style={{ color: C.textMuted }}>
        Real conversion, not just a label: any transaction in one of these currencies gets converted to your default
        currency using the rate in effect as of its own date, before it's summed into any total. A currency with no
        rate here is left unconverted and flagged in Data Quality.
      </p>

      {rates === null ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> Loading…</div>
      ) : (
        <>
          {rates.length === 0 && <p className="text-sm mb-2" style={{ color: C.textMuted }}>No rates set yet — this org's totals only cover its default currency.</p>}
          {rates.map((r) => (
            <div key={r.id} className="flex items-center justify-between text-sm py-1.5" style={{ borderBottom: `1px solid ${C.greyBorderSoft}` }}>
              <span>1 {r.currency} = <span className="tabnum font-medium">{r.rate_to_default}</span> (as of {r.effective_date?.slice?.(0, 10) || r.effective_date})</span>
              <button onClick={() => remove(r.id)} className="text-xs" style={{ color: C.red }}>Remove</button>
            </div>
          ))}
        </>
      )}

      <form onSubmit={submit} className="flex items-end gap-2 mt-4 flex-wrap">
        <div>
          <label className="block text-xs mb-1" style={{ color: C.textMuted }}>Currency</label>
          <input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} placeholder="USD"
            className="w-20 px-2 py-1.5 rounded-lg text-sm tabnum uppercase" style={{ border: `1px solid ${C.greyBorder}` }} />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: C.textMuted }}>Rate to default</label>
          <input value={rateToDefault} onChange={(e) => setRateToDefault(e.target.value)} type="number" step="0.0001" min="0" placeholder="0.92"
            className="w-28 px-2 py-1.5 rounded-lg text-sm tabnum" style={{ border: `1px solid ${C.greyBorder}` }} />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: C.textMuted }}>Effective date</label>
          <input value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} type="date"
            className="px-2 py-1.5 rounded-lg text-sm" style={{ border: `1px solid ${C.greyBorder}` }} />
        </div>
        <button disabled={saving} type="submit" className="px-3 py-1.5 rounded-lg text-sm font-medium text-white disabled:opacity-50" style={{ background: C.blue }}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : "Add rate"}
        </button>
      </form>
    </Card>
  );
}

// FASE 11 — only rendered inside the desktop app (isDesktopApp()). The
// hosted/web version configures ANTHROPIC_API_KEY once on the server for
// every tenant; a desktop install is single-user, so each person supplies
// their own key here instead. Stored in the OS keychain (see
// src-tauri/src/secrets.rs) — DecisionOS itself never sees or stores it
// anywhere else.
function AnthropicKeyCard() {
  const { t } = useLang();
  const toast = useToast();
  const [checking, setChecking] = React.useState(true);
  const [hasKey, setHasKey] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    hasAnthropicKey().then(setHasKey).catch(() => {}).finally(() => setChecking(false));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await saveAnthropicKey(input.trim());
      setHasKey(!!input.trim());
      setInput("");
      toast.success(t("settings.apiKeySaved") || "API key saved securely.");
    } catch (e) {
      toast.error(e.message || "Could not save the key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-3">
        <KeyRound size={15} color={C.blue} />
        <div className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("settings.anthropicKey") || "Anthropic API key"}</div>
      </div>
      <p className="text-sm mb-3" style={{ color: C.textMuted }}>
        {t("settings.anthropicKeyDesc") || "Required for the AI Advisor. Stored securely in your OS's credential store, never in a plain file."}
      </p>
      {checking ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> {t("dq.loading") || "Loading…"}</div>
      ) : (
        <>
          {hasKey && (
            <div className="flex items-center gap-1.5 text-sm mb-2" style={{ color: C.green }}>
              <CheckCircle2 size={14} /> {t("settings.apiKeyConfigured") || "A key is already configured."}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="password"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={hasKey ? (t("settings.apiKeyReplace") || "Enter a new key to replace it…") : "sk-ant-…"}
              className="flex-1 px-3 py-2 rounded-lg text-sm"
              style={{ border: `1px solid ${C.greyBorder}` }}
            />
            <button
              onClick={save}
              disabled={saving || !input.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
              style={{ background: C.blue }}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : (t("settings.save") || "Save")}
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

// Filled in the previously-undefined `SettingsPage` nav target.
export default function SettingsPage({ sourceInfo }) {
  const { t } = useLang();

  return (
    <div>
      <SectionTitle eyebrow={t("nav.settings") || "Settings"} title={t("settings.title")} desc={t("settings.desc")} />

      <div className="grid grid-cols-2 gap-4 mt-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <Wrench size={15} color={C.blue} />
            <div className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("settings.general") || "General"}</div>
          </div>
          <div className="flex items-center justify-between text-sm py-2" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
            <span style={{ color: C.textSecondary }}>{t("settings.language") || "Language"}</span>
            <LangSwitch />
          </div>
          <div className="flex items-center justify-between text-sm py-2" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
            <span style={{ color: C.textSecondary }}>{t("settings.connectedSource") || "Connected source"}</span>
            <span style={{ color: C.charcoal }}>{sourceInfo?.name || sourceInfo?.type || "—"}</span>
          </div>
        </Card>

        {isDesktopApp() ? (
          <AnthropicKeyCard />
        ) : (
          <Card className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <ShieldAlert size={15} color={C.yellow} />
              <div className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("settings.security") || "Security"}</div>
            </div>
            <div className="text-sm" style={{ color: C.textMuted }}>
              {t("settings.securityDesc") || "Credential and connector security is managed per data source — see Data Sources."}
            </div>
          </Card>
        )}

        <OrgCurrencyCard />
        <FxRatesCard />
      </div>
    </div>
  );
}
