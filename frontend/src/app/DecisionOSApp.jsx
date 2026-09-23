import React, { useState, useEffect, useMemo, useRef, Suspense, lazy } from "react";
import {
  AlertTriangle, Gauge, Building2, Zap, Loader2, Users,
  LayoutGrid, BarChart3, TrendingDown, LineChart as LineChartIcon,
  SlidersHorizontal, Sparkles, Database, FileSpreadsheet, Settings, ShieldCheck, ClipboardCheck, PieChart,
} from "lucide-react";
import { C, fontImport } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { apiFetch, apiUpload, pollJob, apiDownload, saveBlob } from "../api/client";
import { generateDemoTransactions } from "../lib/demoData";
import { computeAnalytics, filterTransactions, monthLabel } from "../lib/metrics";
import { normalizeQuality } from "../lib/quality";
import { Card, useToast, EmptyState } from "../components/ui";
import Onboarding from "../components/Onboarding";
import FilterBar from "../components/FilterBar";
import ChatWidget from "../components/ChatWidget";
import LangSwitch from "../components/LangSwitch";
import ThemeSwitch from "../components/ThemeSwitch";
import NotificationBell from "../components/NotificationBell";
import UserMenu from "../components/UserMenu";
import GlobalSearch from "../components/GlobalSearch";

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
const AccountPage = lazy(() => import("../pages/Account/AccountPage"));
const PortfolioPage = lazy(() => import("../pages/Portfolio/PortfolioPage"));

const NAV_MAIN = [
  { id: "overview", key: "nav.overview", icon: LayoutGrid }, { id: "bi", key: "nav.bi", icon: BarChart3 },
  { id: "profit", key: "nav.profit", icon: TrendingDown }, { id: "customers", key: "nav.customers", icon: Users },
  { id: "invest", key: "nav.invest", icon: LineChartIcon },
  { id: "portfolio", key: "nav.portfolio", icon: PieChart },
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

// Everything the header search can jump to (kept module-level so its identity is stable).
const SEARCH_PAGES = [...NAV_MAIN, ...NAV_SECONDARY];
// Views that show the filter bar — a product/region/channel picked in the search
// only makes sense on one of these.
const FILTERED_VIEWS = ["overview", "bi", "profit", "customers", "invest", "sim", "advisor"];

function hydrateAnalytics(data, locale) {
  if (!data) return null;
  return {
    ...data,
    dateRange: { min: new Date(data.dateRange.min), max: new Date(data.dateRange.max) },
    monthly: data.monthly.map((m) => ({ ...m, m: monthLabel(m.key, locale) })),
  };
}

// Mirrors backend requireMinRole("manager") on upload / activate / delete.
const MANAGER_AND_ABOVE = ["manager", "finance", "admin", "owner"];
const canManageData = (role) => MANAGER_AND_ABOVE.includes(role);

function DecisionOSApp({ user, onLogout }) {
  const { t, lang, locale } = useLang();
  const toast = useToast();
  const [view, setView] = useState("overview");
  const [accountTab, setAccountTab] = useState("profile"); // which tab of "My account" is open
  const [showOnboarding, setShowOnboarding] = useState(true);
  // Executive mode ON = charts visible (the default view); OFF = KPIs and AI summary only.
  const [execMode, setExecMode] = useState(true);
  const [demoTransactions] = useState(() => generateDemoTransactions());
  const [baseSourceInfo, setSourceInfo] = useState({ type: "demo", name: "", rows: 0 });
  const [quality, setQuality] = useState(null);
  const [filters, setFilters] = useState({ period: "all", product: "all", region: "all", channel: "all" });
  const [backendAnalytics, setBackendAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsError, setAnalyticsError] = useState("");
  const [checkingExisting, setCheckingExisting] = useState(true);
  const [replaceJob, setReplaceJob] = useState(null); // FASE 8: progress while an import job runs
  const [dataSources, setDataSources] = useState([]); // every file/source this org has uploaded
  const [busySourceId, setBusySourceId] = useState(null); // source being activated/removed right now
  const [exportingSourceId, setExportingSourceId] = useState(null); // source being exported to Excel right now
  const replaceInput = useRef(null);

  useEffect(() => { setSourceInfo((s) => (s.type === "demo" ? { ...s, rows: demoTransactions.length } : s)); }, [demoTransactions]);

  const DEFAULT_FILTERS = { period: "all", product: "all", region: "all", channel: "all" };
  const sourceInfoFrom = (d) => ({ type: d.type, name: d.name, rows: d.row_count || 0, dataSourceId: d.id, lastUpdated: d.last_sync_at });

  // Several files can be included in the analysis at once. `activeIds` is the set
  // the backend is analysing right now; `activeKey` changes exactly when that set
  // does, so it is what triggers a refetch and remounts the pages.
  const activeSources = useMemo(() => dataSources.filter((d) => d.is_active), [dataSources]);
  const activeIds = useMemo(() => activeSources.map((d) => d.id), [activeSources]);
  const activeKey = useMemo(() => activeIds.slice().sort().join(","), [activeIds]);

  // The Data Quality Center shows one report: with several files included, the
  // one with the lowest score (a bad file must not hide behind a good one).
  const qualityFile = useMemo(() => {
    const scored = activeSources.filter((d) => d.quality_score != null && Number.isFinite(Number(d.quality_score)));
    if (scored.length) return scored.reduce((worst, d) => (Number(d.quality_score) < Number(worst.quality_score) ? d : worst));
    return activeSources[0] ?? null;
  }, [activeSources]);

  // What the pages call "the source": the file itself when one is included, a
  // combined description ("3 files", summed rows) when several are. Until the
  // list has loaded (e.g. right after an import) it is whatever was set directly.
  const sourceInfo = useMemo(() => {
    if (baseSourceInfo.type === "demo" || !activeSources.length) return baseSourceInfo;
    if (activeSources.length === 1) return { ...sourceInfoFrom(activeSources[0]), dataSourceIds: activeIds, fileCount: 1 };
    const newest = activeSources.reduce((a, b) => (new Date(b.last_sync_at || 0) > new Date(a.last_sync_at || 0) ? b : a));
    return {
      type: activeSources[0].type,
      name: t("header.nFiles", { n: activeSources.length }),
      rows: activeSources.reduce((sum, d) => sum + (Number(d.row_count) || 0), 0),
      dataSourceId: activeSources[0].id,
      dataSourceIds: activeIds,
      fileCount: activeSources.length,
      lastUpdated: newest.last_sync_at,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSourceInfo, activeSources, activeIds, t]);

  // Refreshes the list of uploaded files/sources. Returns null if it couldn't be loaded.
  const loadSources = async () => {
    try {
      const data = await apiFetch("/api/datasources");
      const list = data.dataSources || [];
      setDataSources(list);
      return list;
    } catch {
      return null;
    }
  };

  // Data-quality report of one source. Without this the quality pages were
  // empty after every page reload, because it was only ever set right after an import.
  const loadQuality = async (dataSourceId) => {
    try {
      setQuality(normalizeQuality(await apiFetch(`/api/datasources/${dataSourceId}/quality`)));
    } catch {
      setQuality(null);
    }
  };

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
        const list = data.dataSources || [];
        if (!cancelled) setDataSources(list);
        // The backend says which ones are included (is_active); the fallback covers a backend that predates it.
        const latest = list.find((d) => d.is_active) || list.find((d) => d.status === "connected" && Number(d.row_count) > 0);
        if (!cancelled && latest) {
          setSourceInfo(sourceInfoFrom(latest));
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

  const isBackendMode = baseSourceInfo.type !== "demo";

  // Load the quality report of the file the Data Quality Center is showing,
  // and again whenever which file that is changes (switch, remove, new import).
  useEffect(() => {
    if (!isBackendMode) return;
    if (qualityFile) loadQuality(qualityFile.id);
    else setQuality(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBackendMode, qualityFile?.id]);

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
  }, [isBackendMode, filters, locale, activeKey]);

  // Demo-mode analytics: computed locally, exactly as before.
  const demoAnalytics = useMemo(
    () => computeAnalytics(filterTransactions(demoTransactions, filters), locale),
    [demoTransactions, filters, locale]
  );

  const analytics = isBackendMode ? backendAnalytics : demoAnalytics;

  const handleDataReady = ({ sourceInfo: s, quality: q }) => {
    setSourceInfo({ ...s, lastUpdated: new Date() }); setQuality(normalizeQuality(q));
    setFilters(DEFAULT_FILTERS);
    loadSources();
  };

  // Include a file in the analysis, or take it out. Several can be included at
  // once; the backend re-points every analytics query to the new set. If the
  // file repeats rows that an included file already has, the backend refuses
  // and lists them — then the person decides whether to include it anyway.
  const toggleSource = async (src, { ignoreDuplicates = false } = {}) => {
    setBusySourceId(src.id);
    try {
      const res = await apiFetch(`/api/datasources/${src.id}/activate${ignoreDuplicates ? "?ignoreDuplicates=true" : ""}`, { method: "POST" });
      setFilters(DEFAULT_FILTERS);
      setBackendAnalytics(null); setAnalyticsLoading(true); // show the loader, not the previous set's numbers
      await loadSources();
      toast.success(t(res.active ? "data.includedNow" : "data.excludedNow", { name: src.name }));
    } catch (e) {
      if (e.code === "possible_duplicates" && !ignoreDuplicates) {
        const overlaps = e.data?.overlaps || [];
        const others = overlaps.map((o) => `"${o.name}"`).join(", ");
        const n = overlaps.reduce((sum, o) => sum + (Number(o.duplicateRowCount) || 0), 0);
        if (window.confirm(t("data.duplicateConfirm", { name: src.name, n: n.toLocaleString(locale), others }))) {
          return toggleSource(src, { ignoreDuplicates: true });
        }
        return;
      }
      toast.error(e.message || t("onboarding.error.readFile"));
    } finally {
      setBusySourceId(null);
    }
  };

  // Remove a file and its imported data. If it was one of the included files the
  // set changes (the backend falls back to the newest remaining file when none
  // is left included); with nothing left at all, back to the upload screen.
  const removeSource = async (src) => {
    if (!window.confirm(t("data.removeConfirm", { name: src.name }))) return;
    setBusySourceId(src.id);
    try {
      const wasIncluded = activeIds.includes(src.id);
      const res = await apiFetch(`/api/datasources/${src.id}`, { method: "DELETE" });
      await loadSources();
      const remaining = res.activeDataSourceIds ?? (res.activeDataSourceId ? [res.activeDataSourceId] : []);
      if (!remaining.length) {
        setSourceInfo({ type: "demo", name: "", rows: demoTransactions.length });
        setQuality(null); setBackendAnalytics(null);
        setShowOnboarding(true);
      } else if (wasIncluded) {
        setFilters(DEFAULT_FILTERS);
        setBackendAnalytics(null); setAnalyticsLoading(true);
      }
      toast.success(t("data.removed", { name: src.name }));
    } catch (e) {
      toast.error(e.message || t("onboarding.error.readFile"));
    } finally {
      setBusySourceId(null);
    }
  };

  // Rename a file. Resolves true/false so the row knows whether to leave edit mode.
  const renameSource = async (src, name) => {
    try {
      const res = await apiFetch(`/api/datasources/${src.id}`, { method: "PATCH", body: { name } });
      await loadSources();
      // the header pill and the Data Quality "Source" card read the name from sourceInfo
      if (src.id === sourceInfo.dataSourceId) setSourceInfo((s) => ({ ...s, name: res.name }));
      toast.success(t("data.renamed", { name: res.name }));
      return true;
    } catch (e) {
      toast.error(e.message || t("onboarding.error.readFile"));
      return false;
    }
  };

  // Download what was imported from a file as .xlsx (the original upload isn't kept).
  const exportSource = async (src) => {
    setExportingSourceId(src.id);
    try {
      const blob = await apiDownload(`/api/datasources/${src.id}/export`);
      const base = src.name.replace(/\.(xlsx|xls|csv)$/i, "");
      saveBlob(blob, `${base}_export.xlsx`);
      toast.success(t("data.exported", { name: src.name }));
    } catch (e) {
      toast.error(e.message || t("onboarding.error.readFile"));
    } finally {
      setExportingSourceId(null);
    }
  };

  // Opening the Data page shows fresh statuses (e.g. a file that was still importing).
  useEffect(() => { if (isBackendMode && view === "data") loadSources(); }, [isBackendMode, view]);

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
      // First data ever (still on demo data): switch to real data. Otherwise the
      // list below decides what is included — a file can be imported but left out.
      setSourceInfo((s) => (s.type === "demo" ? { type: "excel", name: file.name, rows: finished.result.imported, dataSourceId: queued.dataSourceId, lastUpdated: new Date() } : s));
      setFilters(DEFAULT_FILTERS);
      await loadSources();
      if (finished.result.included === false) {
        const others = (finished.result.duplicateOverlaps || []).map((o) => `"${o.name}"`).join(", ");
        toast.info(t("data.notIncludedDuplicate", { name: file.name, others }), { duration: 10000 });
      } else {
        toast.success(t("data.replaceSuccess", { n: finished.result.imported }) || `Imported ${finished.result.imported} rows.`);
      }
    } catch (e) {
      const message = e.message || t("onboarding.error.readFile");
      setAnalyticsError(message);
      toast.error(message);
    } finally {
      setReplaceJob(null);
    }
  };

  const showFilterBar = FILTERED_VIEWS.includes(view);

  // A pick in the header search: open a page, apply a product/region/channel
  // filter, or open the Data page for a file.
  const handleSearchSelect = (action) => {
    if (!action) return;
    if (action.type === "page") setView(action.id);
    else if (action.type === "source") setView("data");
    else if (action.type === "filter") {
      setFilters((f) => ({ ...f, [action.dim]: action.value }));
      setView((v) => (FILTERED_VIEWS.includes(v) ? v : "overview"));
    }
  };

  const renderView = () => {
    // The account page has nothing to do with the loaded data, so it must open
    // even while analytics are loading, failed, or there is no data yet.
    if (view === "account") return <AccountPage user={user} tab={accountTab} onTabChange={setAccountTab} />;
    // Portfolio has its own data (holdings/security_prices), independent of
    // the sales unified model — it must render even in demo mode or while
    // sales analytics are loading/erroring, same reasoning as "account" above.
    if (view === "portfolio") return <PortfolioPage user={user} />;
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
      case "data": return <DataPage analytics={analytics} sourceInfo={sourceInfo} quality={quality} onAdd={() => replaceInput.current?.click()} replaceJob={replaceJob} sources={dataSources} activeIds={activeIds} onToggle={toggleSource} onRemove={removeSource} onRename={renameSource} onExport={exportSource} busyId={busySourceId} exportingId={exportingSourceId} canManage={canManageData(user?.role)} />;
      case "dataQuality": return (
        <DataQualityCenter
          quality={quality}
          sourceInfo={qualityFile ? sourceInfoFrom(qualityFile) : sourceInfo}
          analytics={analytics}
          note={activeSources.length > 1 && qualityFile ? t("dq.scopeNote", { n: activeSources.length, name: qualityFile.name }) : null}
        />
      );
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
          <GlobalSearch pages={SEARCH_PAGES} analytics={analytics} sources={dataSources} onSelect={handleSearchSelect} />
          <div className="flex items-center gap-4">
            <ThemeSwitch />
            <LangSwitch />
            <button onClick={() => setView("data")} className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm" style={{ border: `1px solid ${C.greyBorder}` }}>
              <span className="w-2 h-2 rounded-full" style={{ background: C.green }} />
              <span style={{ color: C.charcoal }}>{sourceInfo.type !== "demo" ? sourceInfo.name : t("header.demoData")}</span>
              <span style={{ color: C.textMuted }}>· {t("header.connected")}</span>
            </button>
            <NotificationBell onNavigate={(target) => target && setView(target)} />
            <UserMenu user={user} onNavigate={(tab) => { setAccountTab(tab); setView("account"); }} onLogout={onLogout} />
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
            <React.Fragment key={activeKey || "demo"}>{renderView()}</React.Fragment>
          </Suspense>
        </main>
      </div>

      <ChatWidget analytics={analytics} filters={filters} sourceInfo={sourceInfo} />
    </div>
  );
}

export default DecisionOSApp;
export { hydrateAnalytics, NAV_MAIN, NAV_SECONDARY };
