import React from "react";
import { X, Loader2, ShieldCheck } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch } from "../../api/client";
import { normalizeQuality, describeIssue } from "../../lib/quality";
import { Modal } from "../../components/ui";

/* ---------------------------------------------------------------
   "Details" of one file/source: where its data comes from, which
   period it covers, how its columns were mapped, and *its own* quality
   report. The Data Quality Center shows just one file (the lowest-quality included one), so
   this is the way to inspect a file without switching to it.
----------------------------------------------------------------*/

const FIELD_ORDER = ["date", "revenue", "cost", "product", "region", "channel", "customer", "quantity", "unit_price", "discount", "currency"];
const SEVERITY_COLOR = { red: C.red, yellow: C.yellow, green: C.green };

function Fact({ label, children }) {
  return (
    <div className="p-3 rounded-xl" style={{ background: C.greyBg }}>
      <div className="text-xs" style={{ color: C.textSecondary }}>{label}</div>
      <div className="tabnum text-sm font-semibold mt-0.5 break-words" style={{ color: C.charcoal }}>{children}</div>
    </div>
  );
}

function formatDate(value, locale) {
  if (!value) return null;
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value); // a bare YYYY-MM-DD is a calendar day, not an instant
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(locale);
}

function SourceDetailsModal({ source, active, onClose }) {
  const { t, locale } = useLang();
  const [state, setState] = React.useState({ loading: true, error: "", details: null, quality: null });

  React.useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "", details: null, quality: null });
    (async () => {
      try {
        const details = await apiFetch(`/api/datasources/${source.id}`);
        // No report yet (e.g. import still running / failed) is a normal 404, not an error.
        const quality = await apiFetch(`/api/datasources/${source.id}/quality`).then(normalizeQuality).catch(() => null);
        if (!cancelled) setState({ loading: false, error: "", details, quality });
      } catch (e) {
        if (!cancelled) setState({ loading: false, error: e.message, details: null, quality: null });
      }
    })();
    return () => { cancelled = true; };
  }, [source.id]);

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { details, quality: q } = state;
  const from = formatDate(details?.dateRange?.from, locale);
  const to = formatDate(details?.dateRange?.to, locale);
  const scoreColor = q ? (q.healthPct >= 90 ? C.green : q.healthPct >= 70 ? C.yellow : C.red) : C.textMuted;
  const mapping = details?.columnMapping || {};
  const mappedFields = FIELD_ORDER.filter((f) => mapping[f]);

  return (
    <Modal>
      <div role="dialog" aria-modal="true" aria-label={source.name}>
        <div className="px-6 py-4 flex items-start justify-between gap-4" style={{ borderBottom: `1px solid ${C.greyBorder}` }}>
          <div className="min-w-0">
            <div className="text-xs font-medium" style={{ color: C.blue }}>{t("data.details")}</div>
            <h2 className="text-lg font-semibold truncate" style={{ color: C.charcoal }}>{source.name}</h2>
          </div>
          <button onClick={onClose} aria-label={t("data.close")} className="p-2 rounded-lg shrink-0" style={{ color: C.textSecondary }}>
            <X size={16} />
          </button>
        </div>

        <div className="p-6 max-h-[70vh] overflow-y-auto">
          {state.loading && (
            <div className="flex items-center gap-2 text-sm" style={{ color: C.textMuted }}>
              <Loader2 size={14} className="animate-spin" /> {t("dq.loading")}
            </div>
          )}
          {state.error && <div className="px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>{state.error}</div>}

          {details && (
            <>
              <div className="grid grid-cols-3 gap-3">
                <Fact label={t("data.detail.status")}>
                  {active ? t("data.included") : details.status === "connected" ? t("data.detail.statusReady") : t(`data.status.${details.status}`)}
                </Fact>
                <Fact label={t("dq.rows")}>{details.rowCount.toLocaleString(locale)}</Fact>
                <Fact label={t("data.detail.period")}>{from && to ? `${from} – ${to}` : "—"}</Fact>
                <Fact label={t("data.detail.type")}>{details.type === "excel" ? "Excel" : details.type}</Fact>
                <Fact label={t("data.detail.uploaded")}>{formatDate(details.createdAt, locale) || "—"}</Fact>
                <Fact label={t("data.detail.uploadedBy")}>{details.createdByName || "—"}</Fact>
              </div>

              <div className="text-sm font-semibold mt-6 mb-2" style={{ color: C.charcoal }}>{t("data.detail.mapping")}</div>
              {mappedFields.length ? (
                <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.greyBorder}` }}>
                  {mappedFields.map((f, i) => (
                    <div key={f} className="flex items-center justify-between gap-3 px-3 py-2 text-sm" style={{ borderTop: i ? `1px solid ${C.greyBorderSoft}` : "none" }}>
                      <span style={{ color: C.textSecondary }}>{t(`data.field.${f}`)}</span>
                      <span className="font-medium truncate" style={{ color: C.charcoal }}>{mapping[f]}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm" style={{ color: C.textMuted }}>—</div>
              )}

              <div className="flex items-center gap-2 mt-6 mb-2">
                <ShieldCheck size={15} color={scoreColor} />
                <span className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("data.quality")}</span>
                {q && <span className="tabnum ml-auto text-sm font-semibold" style={{ color: scoreColor }}>{t("data.healthy", { pct: Math.round(q.healthPct) })}</span>}
              </div>
              {q ? (
                <>
                  <div className="grid grid-cols-4 gap-3">
                    <Fact label={t("quality.missing")}>{q.missingPct ?? "—"}</Fact>
                    <Fact label={t("quality.duplicates")}>{q.duplicates ?? "—"}</Fact>
                    <Fact label={t("quality.invalidIds")}>{q.invalidIds ?? "—"}</Fact>
                    <Fact label={t("quality.inconsistent")}>{q.inconsistent ?? "—"}</Fact>
                  </div>
                  <div className="mt-3 space-y-1">
                    {(q.issues || []).map((it, i) => (
                      <div key={i} className="flex items-center gap-2 text-sm" style={{ color: C.charcoal }}>
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: SEVERITY_COLOR[it.severity] || C.textMuted }} />
                        {describeIssue(it, t, locale)}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="text-sm" style={{ color: C.textMuted }}>{t("data.detail.noQuality")}</div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

export default SourceDetailsModal;
