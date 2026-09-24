import React, { useState } from "react";
import { Sparkles, Loader2 } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { fmtK } from "../../lib/format";
import { buildDigest } from "../../lib/digest";
import { computeEvidenceQuality } from "../../lib/metrics";
import { callClaudeWithTools, ADVISOR_SYSTEM } from "../../api/aiClient";
import { Card, Pill, SectionTitle, SourceBadge, useToast } from "../../components/ui";

/* The model is asked for {title, upsideLow, upsideHigh, why[], limitations},
   but not every model follows that to the letter (numbers as strings, `why`
   as one string or as objects, ...). React crashes the whole page if it is
   handed an object to render, so coerce everything to plain strings/numbers
   here and reject answers with no usable title. */
const asText = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(" ");
  if (typeof v === "object") return Object.values(v).map(asText).filter(Boolean).join(" — ");
  return "";
};
const asNumber = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n) : 0;
};
function normalizeAdvice(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const why = Array.isArray(r.why) ? r.why.map(asText).filter(Boolean) : asText(r.why).split(/\n|•/).map((s) => s.trim()).filter(Boolean);
  const advice = {
    title: asText(r.title),
    upsideLow: asNumber(r.upsideLow),
    upsideHigh: asNumber(r.upsideHigh),
    why,
    limitations: asText(r.limitations),
  };
  if (!advice.title) throw new Error("advisor answer has no title");
  return advice;
}

function AIAdvisor({ analytics, sourceInfo, filters }) {
  const { t, lang, locale } = useLang();
  const toast = useToast();
  const [advice, setAdvice] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const dimLabel = (d) => (d === "Produto" ? t("dim.product") : d === "Região" ? t("dim.region") : d === "Canal" ? t("dim.channel") : d);
  const evidenceQuality = computeEvidenceQuality(analytics);

  const ask = async () => {
    if (sourceInfo?.type === "demo") { setErr(t("advisor.needsRealData")); return; }
    setLoading(true); setErr(""); setAdvice(null);
    try {
      const scope = buildDigest(analytics, filters).activeFilters;
      const userText = lang === "pt"
        ? `Gera uma recomendação de negócio para os dados e filtros atuais. Filtros ativos: ${JSON.stringify(scope)}. Usa as ferramentas disponíveis para reunir evidência antes de responderes.`
        : `Generate a business recommendation for the current data and filters. Active filters: ${JSON.stringify(scope)}. Use the available tools to gather evidence before answering.`;
      const text = await callClaudeWithTools(ADVISOR_SYSTEM[lang], userText, { filters });
      const clean = text.replace(/```json|```/g, "").trim();
      // Llama sometimes adds a sentence before/after the JSON — keep only the {...} block.
      const result = JSON.parse(clean.slice(clean.indexOf("{"), clean.lastIndexOf("}") + 1));
      setAdvice(normalizeAdvice(result));
    } catch (e) {
      setErr(t("advisor.error"));
      toast.error(t("advisor.error"));
    } finally { setLoading(false); }
  };

  return (
    <div>
      <SectionTitle eyebrow="What should we do?" title="AI Advisor" desc={t("advisor.desc")} />
      <SourceBadge sourceInfo={sourceInfo} />

      {!advice && !loading && (
        <Card className="p-10 text-center">
          <Sparkles size={22} color={C.blue} className="mx-auto" />
          <p className="mt-3 text-sm" style={{ color: C.textSecondary }}>{t("advisor.empty")}</p>
          <button onClick={ask} className="mt-4 px-5 py-2.5 rounded-xl text-sm font-medium text-white" style={{ background: C.blue }}>{t("advisor.generate")}</button>
        </Card>
      )}
      {loading && (
        <Card className="p-10 text-center">
          <Loader2 size={22} color={C.blue} className="mx-auto animate-spin" />
          <p className="mt-3 text-sm" style={{ color: C.textSecondary }}>{t("advisor.loading")}</p>
        </Card>
      )}
      {err && <Card className="p-6 mb-4" style={{ background: C.redSoft, borderColor: "transparent" }}><span style={{ color: C.red }} className="text-sm">{err}</span></Card>}

      {advice && (
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <Pill tone="blue"><Sparkles size={12} /> {t("advisor.badge")}</Pill>
              <h3 className="mt-3 text-xl font-semibold" style={{ color: C.charcoal }}>{advice.title}</h3>
              <div className="tabnum mt-1 text-lg font-semibold" style={{ color: C.green }}>
                €{advice.upsideLow}K – €{advice.upsideHigh}K <span className="text-sm font-normal" style={{ color: C.textSecondary }}>{t("advisor.upsideEstimated")}</span>
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-xs" style={{ color: C.textSecondary }}>{t("advisor.confidence")}</div>
              <div className="tabnum text-2xl font-semibold" style={{ color: evidenceQuality.level === "high" ? C.green : evidenceQuality.level === "medium" ? C.yellow : C.red }}>
                {t(`advisor.evidenceQuality.${evidenceQuality.level}`)}
              </div>
              <div className="text-xs mt-0.5" style={{ color: C.textMuted }}>{t("advisor.evidenceQuality.basis", { months: evidenceQuality.months, rows: evidenceQuality.rows })}</div>
            </div>
          </div>
          <div className="mt-5">
            <div className="text-sm font-semibold mb-2" style={{ color: C.charcoal }}>{t("advisor.why")}</div>
            <ul className="space-y-1.5 text-sm" style={{ color: C.textSecondary }}>{advice.why?.map((w, i) => <li key={i}>• {w}</li>)}</ul>
          </div>
          <div className="mt-5">
            <div className="text-sm font-semibold mb-2" style={{ color: C.charcoal }}>{t("advisor.evidence")}</div>
            {analytics.leakage.length ? (
              <div className="space-y-2">
                {analytics.leakage.map((l) => (
                  <div key={l.name} className="flex items-center justify-between p-3 rounded-xl text-sm" style={{ background: C.greyBg }}>
                    <div style={{ color: C.charcoal }}>
                      <span className="font-medium">{l.name}</span> <span style={{ color: C.textMuted }}>({dimLabel(l.dim)})</span>
                      <span className="tabnum" style={{ color: C.textSecondary }}> · {l.marginBefore.toFixed(1)}% → {l.marginAfter.toFixed(1)}% ({l.deltaPP.toFixed(1)}pp)</span>
                    </div>
                    <div className="tabnum font-semibold shrink-0 ml-3" style={{ color: C.red }}>{fmtK(l.impact, locale)}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm" style={{ color: C.textMuted }}>{t("advisor.evidence.empty")}</div>
            )}
          </div>
          <div className="mt-5 p-3 rounded-xl text-sm" style={{ background: C.yellowSoft, color: C.yellow }}>{t("advisor.limitations", { l: advice.limitations })}</div>
          <div className="mt-5 flex gap-2">
            <button onClick={ask} className="px-4 py-2.5 rounded-xl text-sm font-medium text-white" style={{ background: C.blue }}>{t("advisor.regenerate")}</button>
          </div>
        </Card>
      )}
    </div>
  );
}


export default AIAdvisor;
