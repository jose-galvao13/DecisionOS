import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import {
  Search, Bell, AlertTriangle, Gauge, Building2, Zap, Loader2, Users,
  LayoutGrid, BarChart3, TrendingDown, LineChart as LineChartIcon,
  SlidersHorizontal, Sparkles, Database, FileSpreadsheet, Settings, ShieldCheck, ClipboardCheck,
} from "lucide-react";
import { C, fontImport } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { apiFetch, apiUpload, pollJob } from "../api/client";
import { generateDemoTransactions } from "../lib/demoData";
import { computeAnalytics, filterTransactions, monthLabel } from "../lib/metrics";
import { Card, useToast, EmptyState } from "../components/ui";
import Onboarding from "../components/Onboarding";
import FilterBar from "../components/FilterBar";
import ChatWidget from "../components/ChatWidget";
import LangSwitch from "../components/LangSwitch";
import ThemeSwitch from "../components/ThemeSwitch";

// Lazy-loaded: each page becomes its own chunk instead of one ~700KB
// bundle. Nothing here needs to be ready before first paint — the shell
// (nav, filters, onboarding) loads first, and whichever page the user
// actually opens is fetched on demand. See the Suspense fallback in
// renderView() below for the loading state shown while a chunk fetches.
const Overview = lazy(() => import("../pages/Dashboard/Overview"));
const BusinessIntelligence = lazy(() => import("../pages/Analytics/BusinessIntelligence"));
const ProfitIntelligence = lazy(() => import("../pages/Analytics/ProfitIntelligence"));
const InvestmentIntelligence = lazy(() => import("../pages/Analytics/InvestmentIntelligence"));
const ReportsPage = lazy(() => import("../pages/Analytics/ReportsPage"));
const DecisionSimulator = lazy(() => import("../pages/Decisions/DecisionSimulator"));
const AIAdvisor = lazy(() => import("../pages/Advisor/AIAdvisor"));
const DataPage = lazy(() => import("../pages/DataSources/DataPage"));
const DataQualityCenter = lazy(() => import("../pages/DataQuality/DataQualityCenter"));
const CustomerIntelligenceView = lazy(() => import("../pages/Customers/CustomerIntelligenceView"));
const ProductsPage = lazy(() => import("../pages/Products/ProductsPage"));
const SettingsPage = lazy(() => import("../pages/Settings/SettingsPage"));
const DecisionLogPage = lazy(() => import("../pages/Decisions/DecisionLogPage"));

const NAV_MAIN = [
  { id: "overview", key: "nav.overview", icon: LayoutGrid }, { id: "bi", key: "nav.bi", icon: BarChart3 },
  { id: "profit", key: "nav.profit", icon: TrendingDown }, { id: "customers", key: "nav.customers", icon: Users },
  { id: "invest", key: "nav.invest", icon: LineChartIcon },
  { id: "sim", key: "nav.sim", icon: SlidersHorizontal }, { id: "advisor", key: "nav.advisor", icon: Sparkles },
  { id: "decisionLog", key: "nav.decisionLog", icon: ClipboardCheck },
];
const NAV_SECONDARY = [
  { id: "data", key: "nav.data", icon: Database },
  { id: "dataQuality", key: "nav.dataQuality", icon: ShieldCheck },
  { id: "products", key: "nav.products", icon: FileSpreadsheet },
  { id: "reports", key: "nav.reports", icon: FileSpreadsheet },
  { id: "settings", key: "nav.settings", icon: Settings },
];

function hydrateAnalytics(data, locale) {
  if (!data) return null;
  return {
    ...data,
    dateRange: { min: new Date(data.dateRange.min), max: new Date(data.dateRange.max) },
    monthly: data.monthly.map((m) => ({ ...m, m: monthLabel(m.key, locale) })),
  };
}

function DecisionOSApp({ user, onLogout }) {
  const { t, lang, locale } = useLang();
  const toast = useToast();
  const [view, setView] = useState("overview");
  const [showOnboarding, setShowOnboarding] = useState(true);
  // Executive mode ON = charts visible (the default view); OFF = KPIs and AI summary only.
  const [execMode, setExecMode] = useState(true);
  const [demoTransactions] = useState(() => generateDemoTransactions());
  const [sourceInfo, setSourceInfo] = useState({ type: "demo", name: "", rows: 0 });
  const [quality, setQuality] = useState(null);
  const [filters, setFilters] = useState({ period: "all", product: "all", region: "all", channel: "all" });
  const [backendAnalytics, setBackendAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState("");
  const [checkingExisting, setCheckingExisting] = useState(true);
  const [replaceJob, setReplaceJob] = useState(null); // FASE 8: progress while a replace-data job runs
  const replaceInput = useRef(null);

  useEffect(() => { setSourceInfo((s) => (s.type === "demo" ? { ...s, rows: demoTransactions.length } : s)); }, [demoTransactions]);

  // On first load, if this org already has a data source connected from a
  // previous session, pick it up automatically instead of forcing the
  // onboarding modal back onto demo data every time.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch("/api/datasources");
        // Only pick up a source that actually imported data. A previous
        // failed/half-finished import leaves a data_sources row with
        // status 'error' (or 'syncing') and 0 rows; treating that as
        // "connected" hid the onboarding modal and left the user with an
        // empty dashboard and no obvious way to upload again.
        const latest = data.dataSources?.find((d) => d.status === "connected" && Number(d.row_count) > 0);
        if (!cancelled && latest) {
          setSourceInfo({ type: latest.type, name: latest.name, rows: latest.row_count || 0, dataSourceId: latest.id, lastUpdated: latest.last_sync_at });
          setShowOnboarding(false);
        }
      } catch {
        // no data sources yet (or listing failed) — demo mode stays as-is
      } finally {
        if (!cancelled) setCheckingExisting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isBackendMode = sourceInfo.type !== "demo";

  // Backend-driven analytics: refetch whenever the active filters change.
  useEffect(() => {
    if (!isBackendMode) { setBackendAnalytics(null); return; }
    let cancelled = false;
    setAnalyticsLoading(true); setAnalyticsError("");
    const qs = new URLSearchParams({ period: filters.period || "all" });
    if (filters.product && filters.product !== "all") qs.set("product", filters.product);
    if (filters.region && filters.region !== "all") qs.set("region", filters.region);
    if (filters.channel && filters.channel !== "all") qs.set("channel", filters.channel);
    apiFetch(`/api/analytics/full?${qs.toString()}`)
      .then((data) => { if (!cancelled) setBackendAnalytics(hydrateAnalytics(data, locale)); })
      .catch((e) => { if (!cancelled) { setAnalyticsError(e.message); setBackendAnalytics(null); } })
      .finally(() => { if (!cancelled) setAnalyticsLoading(false); });
    return () => { cancelled = true; };
  }, [isBackendMode, filters, locale]);

  // Demo-mode analytics: computed locally, exactly as before.
  const demoAnalytics = useMemo(
    () => computeAnalytics(filterTransactions(demoTransactions, filters), locale),
    [demoTransactions, filters, locale]
  );

  const analytics = isBackendMode ? backendAnalytics : demoAnalytics;

  const handleDataReady = ({ sourceInfo: s, quality: q }) => {
    setSourceInfo({ ...s, lastUpdated: new Date() }); setQuality(q);
    setFilters({ period: "all", product: "all", region: "all", channel: "all" });
  };

  // Quick "replace data" from the Data page — same backend upload path as
  // onboarding, but auto-confirms the backend's suggested mapping instead
  // of showing the review step again. FASE 8: commit now returns a jobId
  // (202) instead of the finished result — poll it and surface progress +
  // a toast on completion/failure, same pattern as Onboarding.jsx.
  const handleReplace = async (file) => {
    setAnalyticsError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const preview = await apiUpload("/api/datasources/excel/preview", fd);
      if (!preview.suggestedMapping.date || !preview.suggestedMapping.revenue) {
        setAnalyticsError(t("onboarding.error.noValidRows"));
        return;
      }
      setReplaceJob({ progress: 0, stage: "queued" });
      const queued = await apiFetch("/api/datasources/excel/commit", {
        method: "POST",
        body: { stagingId: preview.stagingId, mapping: preview.suggestedMapping, name: file.name },
      });
      const finished = await pollJob(queued.jobId, { onProgress: setReplaceJob });
      setSourceInfo({ type: "excel", name: file.name, rows: finished.result.imported, dataSourceId: queued.dataSourceId, lastUpdated: new Date() });
      setQuality(finished.result.dataQuality);
      setFilters({ period: "all", product: "all", region: "all", channel: "all" });
      toast.success(t("data.replaceSuccess", { n: finished.result.imported }) || `Imported ${finished.result.imported} rows.`);
    } catch (e) {
      const message = e.message || t("onboarding.error.readFile");
      setAnalyticsError(message);
      toast.error(message);
    } finally {
      setReplaceJob(null);
    }
  };

  const showFilterBar = ["overview", "bi", "profit", "customers", "invest", "sim", "advisor"].includes(view);

  const renderView = () => {
    if (isBackendMode && analyticsLoading && !analytics) {
      return (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Loader2 size={24} className="animate-spin" color={C.textMuted} />
          <p className="text-sm mt-3" style={{ color: C.textMuted }}>{t("analytics.loading")}</p>
        </div>
      );
    }
    if (isBackendMode && analyticsError && !analytics) {
      return <EmptyState icon={AlertTriangle} title={t("analytics.errorTitle") || "Couldn't load analytics"} desc={analyticsError || t("analytics.noData")} />;
    }
    if (!analytics) {
      return <EmptyState icon={AlertTriangle} desc={t("filter.emptyPeriod")} />;
    }
    switch (view) {
      case "overview": return <Overview analytics={analytics} sourceInfo={sourceInfo} execMode={execMode} filters={filters} user={user} />;
      case "bi": return <BusinessIntelligence analytics={analytics} sourceInfo={sourceInfo} />;
      case "profit": return <ProfitIntelligence analytics={analytics} sourceInfo={sourceInfo} />;
      case "customers": return <CustomerIntelligenceView analytics={analytics} sourceInfo={sourceInfo} />;
      case "invest": return <InvestmentIntelligence analytics={analytics} sourceInfo={sourceInfo} />;
      case "sim": return <DecisionSimulator filters={filters} sourceInfo={sourceInfo} />;
      case "advisor": return <AIAdvisor analytics={analytics} sourceInfo={sourceInfo} filters={filters} />;
      case "decisionLog": return <DecisionLogPage user={user} />;
      case "data": return <DataPage analytics={analytics} sourceInfo={sourceInfo} quality={quality} onReplace={() => replaceInput.current?.click()} replaceJob={replaceJob} />;
      case "dataQuality": return <DataQualityCenter quality={quality} sourceInfo={sourceInfo} analytics={analytics} />;
      case "products": return <ProductsPage analytics={analytics} sourceInfo={sourceInfo} />;
      case "reports": return <ReportsPage analytics={analytics} sourceInfo={sourceInfo} />;
      case "settings": return <SettingsPage sourceInfo={sourceInfo} />;
      default: return <EmptyState icon={Building2} desc={t("underConstruction.desc")} />;
    }
  };

  return (
    <div className="app-shell w-full h-full flex" style={{ background: C.greyBg, minHeight: 700 }}>
      <style>{fontImport}</style>
      {!checkingExisting && showOnboarding && <Onboarding onFinish={() => setShowOnboarding(false)} onDataReady={handleDataReady} />}
      <input ref={replaceInput} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => e.target.files[0] && handleReplace(e.target.files[0])} />

      <aside className="w-60 shrink-0 flex flex-col" style={{ background: C.navyDeep }}>
        <div className="px-5 py-5 flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: C.blue }}><Zap size={15} color="white" /></div>
          <span className="text-white font-semibold text-[15px]">DecisionOS</span>
        </div>
        <nav className="flex-1 px-3 mt-2">
          {NAV_MAIN.map((n) => {
            const Icon = n.icon; const active = view === n.id;
            return <button key={n.id} onClick={() => setView(n.id)} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm mb-1 transition-colors" style={active ? { background: C.navySoft, color: C.white, fontWeight: 600 } : { color: "#9CAAC2" }}><Icon size={16} />{t(n.key)}</button>;
          })}
          <div className="mt-5 mb-2 px-3 text-xs" style={{ color: "#5E6C85" }}>{t("nav.more")}</div>
          {NAV_SECONDARY.map((n) => {
            const Icon = n.icon; const active = view === n.id;
            return <button key={n.id} onClick={() => setView(n.id)} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm mb-1" style={active ? { background: C.navySoft, color: C.white, fontWeight: 600 } : { color: "#9CAAC2" }}><Icon size={16} />{t(n.key)}</button>;
          })}
        </nav>
        <div className="p-3">
          <button onClick={() => setExecMode((e) => !e)} className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm" style={{ background: execMode ? C.blue : C.navySoft, color: "white" }}>
            <Gauge size={16} /> {execMode ? t("execMode.on") : t("execMode.off")}
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="app-header h-16 shrink-0 flex items-center justify-between px-6" style={{ background: C.surface, borderBottom: `1px solid ${C.greyBorder}` }}>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg" style={{ background: C.greyBg, width: 320 }}>
            <Search size={15} color={C.textMuted} /><span className="text-sm" style={{ color: C.textMuted }}>{t("search.placeholder")}</span>
          </div>
          <div className="flex items-center gap-4">
            <ThemeSwitch />
            <LangSwitch />
            <button onClick={() => setView("data")} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm" style={{ border: `1px solid ${C.greyBorder}` }}>
              <span className="w-2 h-2 rounded-full" style={{ background: C.green }} />
              <span style={{ color: C.charcoal }}>{sourceInfo.type !== "demo" ? sourceInfo.name : t("header.demoData")}</span>
              <span style={{ color: C.textMuted }}>· {t("header.connected")}</span>
            </button>
            <Bell size={17} color={C.textSecondary} />
            <button onClick={onLogout} title={t("auth.logout")} className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold text-white" style={{ background: C.blueDark }}>
              {(user?.name || "?").split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase()}
            </button>
          </div>
        </header>
        <main className="app-main flex-1 overflow-y-auto p-8">
          {showFilterBar && <FilterBar analytics={analytics} filters={filters} onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))} />}
          <Suspense
            fallback={
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <Loader2 size={24} className="animate-spin" color={C.textMuted} />
                <p className="text-sm mt-3" style={{ color: C.textMuted }}>{t("analytics.loading")}</p>
              </div>
            }
          >
            {renderView()}
          </Suspense>
        </main>
      </div>

      <ChatWidget analytics={analytics} filters={filters} sourceInfo={sourceInfo} />
    </div>
  );
}

export default DecisionOSApp;
export { hydrateAnalytics, NAV_MAIN, NAV_SECONDARY };
