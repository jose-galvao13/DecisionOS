import React, { useState, useRef } from "react";
import * as XLSX from "xlsx";
import { Database, FileSpreadsheet, ChevronRight, CheckCircle2, AlertTriangle, ArrowRight, Loader2, Upload } from "lucide-react";
import { C } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { apiUpload, apiFetch, pollJob } from "../api/client";
import { detectMapping, buildUnifiedModel, computeDataQuality } from "../lib/mapping";
import { Card, Modal, JobProgress, Pill } from "./ui";

/* ---------------------------------------------------------------
   ONBOARDING — real Excel parsing + mapping + simulated Database
----------------------------------------------------------------*/
// Field list + display labels for the mapping-review step. These match the
// backend's column-detection keys exactly (src/services/columnDetection.js)
// since the mapping object built here is sent straight to
// POST /api/datasources/excel/commit — no translation layer in between.
const MAPPING_FIELDS = ["date", "revenue", "cost", "product", "region", "channel", "customer", "quantity", "unit_price", "discount", "currency"];
const MAPPING_FIELD_LABELS = {
  date: "date", revenue: "revenue", cost: "cost", product: "product", region: "region",
  channel: "channel", customer: "customer", quantity: "quantity", unit_price: "unit price", discount: "discount",
  currency: "currency",
};

function Onboarding({ onFinish, onDataReady }) {
  const { t } = useLang();
  const [step, setStep] = useState("choose");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [rowCount, setRowCount] = useState(0);
  const [mapping, setMapping] = useState({});
  const [stagingId, setStagingId] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState(null); // FASE 8: { progress, stage } while the worker is importing
  const fileInput = useRef(null);

  const STAGE_LABELS = {
    queued: t("onboarding.stage.queued") || "Queued…",
    starting: t("onboarding.stage.starting") || "Starting…",
    validating: t("onboarding.stage.validating") || "Validating rows…",
    importing: t("onboarding.stage.importing") || "Importing rows…",
    analytics: t("onboarding.stage.analytics") || "Finishing up…",
    connecting: t("onboarding.stage.connecting") || "Connecting…",
    fetching: t("onboarding.stage.fetching") || "Fetching data…",
  };

  // Uploads the raw file straight to the backend, which parses it,
  // stages the rows server-side, and suggests a column mapping — nothing
  // is persisted yet. This replaced client-side XLSX parsing so preview,
  // mapping and the eventual commit are all working off the exact same
  // server-side staging row set (see src/routes/datasources.routes.js).
  const handleFile = async (file) => {
    setError(""); setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const data = await apiUpload("/api/datasources/excel/preview", fd);
      setHeaders(data.headers);
      setRows(data.sampleRows);
      setRowCount(data.rowCount);
      setMapping(data.suggestedMapping);
      setStagingId(data.stagingId);
      setFileName(file.name);
      setStep("preview");
    } catch (e) {
      setError(e.message || t("onboarding.error.readFile"));
    } finally {
      setBusy(false);
    }
  };

  // Commits the staged rows under the confirmed mapping. FASE 8: this now
  // returns 202 + a jobId immediately (the worker does the actual import
  // in the background) — poll until it completes/fails and show real
  // progress instead of a single opaque spinner for the whole import.
  const confirmMapping = async () => {
    setError(""); setBusy(true); setStep("importing"); setJob({ progress: 0, stage: "queued" });
    try {
      const queued = await apiFetch("/api/datasources/excel/commit", {
        method: "POST",
        body: { stagingId, mapping, name: fileName },
      });
      const finished = await pollJob(queued.jobId, { onProgress: setJob });
      onDataReady({
        sourceInfo: { type: "excel", name: fileName, rows: finished.result.imported, dataSourceId: queued.dataSourceId },
        quality: finished.result.dataQuality,
      });
      setStep("done");
    } catch (e) {
      setError(e.message || t("onboarding.error.noValidRows"));
      setStep("preview");
    } finally {
      setBusy(false);
    }
  };

  if (step === "choose") {
    return (
      <Modal>
        <div className="px-8 pt-8 pb-6" style={{ background: C.navyDeep }}>
          <div className="text-sm font-medium" style={{ color: "#9DB7E8" }}>DecisionOS</div>
          <h2 className="mt-2 text-2xl font-semibold text-white">{t("onboarding.title")}</h2>
          <p className="mt-1 text-sm" style={{ color: "#B7C4DA" }}>{t("onboarding.subtitle")}</p>
        </div>
        <div className="p-6 grid grid-cols-2 gap-4">
          <button onClick={() => fileInput.current?.click()} className="text-left p-5 rounded-2xl transition-colors" style={{ border: `1.5px solid ${C.greyBorder}` }}>
            <input ref={fileInput} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} />
            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: C.blueSoft }}><FileSpreadsheet size={20} color={C.blue} /></div>
            <div className="font-semibold" style={{ color: C.charcoal }}>{t("onboarding.excel.title")}</div>
            <p className="mt-1 text-sm" style={{ color: C.textSecondary }}>{t("onboarding.excel.desc")}</p>
            <div className="mt-3 inline-flex items-center gap-1 text-sm font-medium" style={{ color: C.blue }}>{t("onboarding.excel.cta")} <ChevronRight size={15} /></div>
          </button>
          <button onClick={() => setStep("db-sim")} className="text-left p-5 rounded-2xl transition-colors" style={{ border: `1.5px solid ${C.greyBorder}` }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3" style={{ background: C.blueSoft }}><Database size={20} color={C.blue} /></div>
            <div className="font-semibold" style={{ color: C.charcoal }}>{t("onboarding.db.title")}</div>
            <p className="mt-1 text-sm" style={{ color: C.textSecondary }}>{t("onboarding.db.desc")}</p>
            <div className="mt-3 inline-flex items-center gap-1 text-sm font-medium" style={{ color: C.blue }}>{t("onboarding.db.cta")} <ChevronRight size={15} /></div>
          </button>
        </div>
        {busy && <div className="mx-6 mb-4 px-3 py-2 rounded-lg text-sm flex items-center gap-2" style={{ background: C.blueSoft, color: C.blue }}><Loader2 size={14} className="animate-spin" /> {t("onboarding.uploading")}</div>}
        {error && <div className="mx-6 mb-4 px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>{error}</div>}
        <div className="px-6 pb-6 text-center">
          <button onClick={onFinish} className="text-sm" style={{ color: C.textMuted }}>{t("onboarding.useDemo")}</button>
        </div>
      </Modal>
    );
  }

  if (step === "db-sim") {
    return (
      <Modal>
        <div className="p-8">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center mb-4" style={{ background: C.yellowSoft }}><AlertTriangle size={20} color={C.yellow} /></div>
          <h2 className="text-xl font-semibold" style={{ color: C.charcoal }}>{t("onboarding.dbsim.title")}</h2>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: C.textSecondary }}>{t("onboarding.dbsim.p1")}</p>
          <p className="mt-3 text-sm" style={{ color: C.textSecondary }}>{t("onboarding.dbsim.p2")}</p>
          <div className="mt-6 flex gap-2">
            <button onClick={() => setStep("choose")} className="px-4 py-2.5 rounded-xl text-sm font-medium" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }}>{t("onboarding.back")}</button>
            <button onClick={onFinish} className="px-4 py-2.5 rounded-xl text-sm font-medium text-white" style={{ background: C.blue }}>{t("onboarding.continueDemo")}</button>
          </div>
        </div>
      </Modal>
    );
  }

  if (step === "preview") {
    const sample = rows.slice(0, 3);
    return (
      <Modal wide>
        <div className="px-8 py-6 flex items-center justify-between" style={{ borderBottom: `1px solid ${C.greyBorder}` }}>
          <div>
            <div className="text-sm font-medium" style={{ color: C.blue }}>{t("onboarding.preview.label")}</div>
            <h2 className="text-xl font-semibold" style={{ color: C.charcoal }}>{fileName}</h2>
          </div>
          <Pill tone="green"><CheckCircle2 size={13} /> {t("onboarding.preview.rowsDetected", { n: rowCount })}</Pill>
        </div>
        <div className="p-6 max-h-[60vh] overflow-y-auto">
          <div className="rounded-xl overflow-hidden mb-5" style={{ border: `1px solid ${C.greyBorder}` }}>
            <table className="w-full text-sm">
              <thead><tr style={{ background: C.greyBg, color: C.textSecondary }}>{headers.map((h) => <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody className="tabnum">
                {sample.map((r, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.greyBorderSoft}` }}>
                    {headers.map((h) => <td key={h} className="px-3 py-2 whitespace-nowrap">{String(r[h]).slice(0, 24)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="text-sm font-medium mb-2" style={{ color: C.charcoal }}>{t("onboarding.preview.foundLabel")}</div>
          <div className="space-y-2">
            {MAPPING_FIELDS.map((field) => (
              <div key={field} className="flex items-center gap-2 text-sm">
                {mapping[field] ? <CheckCircle2 size={15} color={C.green} /> : <AlertTriangle size={15} color={C.yellow} />}
                <span className="capitalize w-24 shrink-0" style={{ color: C.charcoal }}>{MAPPING_FIELD_LABELS[field]}</span>
                <ArrowRight size={13} color={C.textMuted} />
                <select
                  value={mapping[field] || ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || null }))}
                  className="text-sm px-2 py-1 rounded-lg outline-none"
                  style={{ border: `1px solid ${C.greyBorder}`, color: mapping[field] ? C.charcoal : C.yellow, background: mapping[field] ? C.surface : C.yellowSoft }}
                >
                  <option value="">{t("onboarding.preview.unmapped")}</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
        {error && <div className="mx-6 mb-4 px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>{error}</div>}
        <div className="px-6 pb-6 flex items-center justify-between">
          <button onClick={() => setStep("choose")} className="text-sm" style={{ color: C.textMuted }}>{t("onboarding.back")}</button>
          <button onClick={confirmMapping} disabled={!mapping.date || !mapping.revenue}
            className="px-4 py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-40"
            style={{ background: C.blue }}>
            {t("onboarding.preview.confirm")}
          </button>
        </div>
      </Modal>
    );
  }

  if (step === "importing") {
    return (
      <Modal narrow>
        <div className="p-8">
          <div className="text-sm font-medium mb-1" style={{ color: C.blue }}>{t("onboarding.importing.label") || "Importing"}</div>
          <h2 className="text-xl font-semibold mb-6" style={{ color: C.charcoal }}>{fileName}</h2>
          <JobProgress progress={job?.progress || 0} stage={job?.stage} stageLabels={STAGE_LABELS} />
          <p className="mt-4 text-sm" style={{ color: C.textMuted }}>
            {t("onboarding.importing.hint") || "This runs in the background — you can keep this open, it'll finish automatically."}
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal narrow>
      <div className="p-8 text-center">
        <div className="w-14 h-14 mx-auto rounded-2xl flex items-center justify-center" style={{ background: C.greenSoft }}><CheckCircle2 size={26} color={C.green} /></div>
        <h2 className="mt-4 text-xl font-semibold" style={{ color: C.charcoal }}>{t("onboarding.done.title")}</h2>
        <p className="mt-1 text-sm" style={{ color: C.textSecondary }}>{t("onboarding.done.desc")}</p>
        <button onClick={onFinish} className="mt-6 w-full py-2.5 rounded-xl text-sm font-medium text-white" style={{ background: C.blue }}>{t("onboarding.done.cta")}</button>
      </div>
    </Modal>
  );
}

export default Onboarding;
