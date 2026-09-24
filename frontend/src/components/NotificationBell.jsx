import React from "react";
import { Bell, ClipboardCheck, CheckCircle2, XCircle, Target, FileWarning, ShieldAlert, AlertTriangle, Loader2, CheckCheck, PieChart } from "lucide-react";
import { C } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { apiFetch } from "../api/client";
import { timeAgo } from "../lib/format";
import { describeNotification } from "../lib/notifications";
import { Popover } from "./ui";

/* ---------------------------------------------------------------
   NOTIFICATION BELL — what needs this person's attention right now.

   The list comes from GET /api/notifications (derived from live data on the
   server: decisions waiting for approval, your decisions approved/rejected,
   measured outcomes, failed imports, poor data quality, red findings from the
   Decision Engine, a concentrated stock portfolio). Only "read" marks are stored, per person, on the server —
   so they follow the person across browsers.

   Refreshes when opened and once a minute while the tab is visible.
----------------------------------------------------------------*/
const POLL_MS = 60_000;

const KIND_ICON = {
  approval_pending: ClipboardCheck, decision_approved: CheckCircle2, decision_rejected: XCircle,
  outcome_measured: Target, import_failed: FileWarning, low_quality: ShieldAlert, risk: AlertTriangle,
  portfolio_concentration: PieChart,
};
const TONE = {
  red: { fg: C.red, bg: C.redSoft }, yellow: { fg: C.yellow, bg: C.yellowSoft },
  green: { fg: C.green, bg: C.greenSoft }, blue: { fg: C.blue, bg: C.blueSoft },
};

function NotificationBell({ onNavigate }) {
  const { t, locale } = useLang();
  const [state, setState] = React.useState({ items: [], unread: 0, loading: true, error: false });

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch("/api/notifications");
      setState({ items: data.notifications || [], unread: data.unreadCount || 0, loading: false, error: false });
    } catch {
      // keep whatever we already showed; only say "couldn't load" when there is nothing to show
      setState((s) => ({ ...s, loading: false, error: true }));
    }
  }, []);

  React.useEffect(() => {
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const markRead = async (body) => {
    try { await apiFetch("/api/notifications/read", { method: "POST", body }); } catch { /* a missed read mark is harmless: it shows as unread again */ }
  };

  const openItem = (n, close) => {
    if (!n.read) {
      setState((s) => ({ ...s, unread: Math.max(0, s.unread - 1), items: s.items.map((x) => (x.key === n.key ? { ...x, read: true } : x)) }));
      markRead({ keys: [n.key] });
    }
    close();
    onNavigate?.(n.target?.view);
  };

  const markAll = () => {
    setState((s) => ({ ...s, unread: 0, items: s.items.map((x) => ({ ...x, read: true })) }));
    markRead({ all: true });
  };

  const label = state.unread > 0 ? t("notif.bellUnread", { n: state.unread }) : t("notif.bell");

  return (
    <Popover
      label={t("notif.title")}
      role="dialog"
      onOpenChange={(open) => { if (open) load(); }}
      panelStyle={{ width: 380, maxWidth: "calc(100vw - 16px)" }}
      renderTrigger={({ ref, open, toggle }) => (
        <button
          ref={ref}
          type="button"
          aria-label={label}
          title={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={toggle}
          className="relative p-2 rounded-lg"
          style={{ color: C.textSecondary, background: open ? C.greyBg : "transparent" }}
        >
          <Bell size={17} />
          {state.unread > 0 && (
            <span
              data-testid="bell-badge"
              className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full text-[10px] leading-4 font-semibold text-center"
              style={{ background: C.red, color: "#fff" }}
            >
              {state.unread > 9 ? "9+" : state.unread}
            </span>
          )}
        </button>
      )}
    >
      {({ close }) => (
        <div>
          <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: `1px solid ${C.greyBorder}` }}>
            <span className="text-sm font-semibold" style={{ color: C.charcoal }}>{t("notif.title")}</span>
            {state.unread > 0 && (
              <button onClick={markAll} className="flex items-center gap-1.5 text-xs font-medium" style={{ color: C.blue }}>
                <CheckCheck size={13} /> {t("notif.markAll")}
              </button>
            )}
          </div>

          <div className="max-h-[420px] overflow-y-auto">
            {state.loading && (
              <div className="flex items-center gap-2 px-4 py-6 text-sm" style={{ color: C.textMuted }}>
                <Loader2 size={14} className="animate-spin" /> {t("notif.loading")}
              </div>
            )}

            {!state.loading && state.error && !state.items.length && (
              <div className="px-4 py-6 text-sm text-center" style={{ color: C.textSecondary }}>
                <div>{t("notif.loadError")}</div>
                <button onClick={load} className="mt-2 text-xs font-medium" style={{ color: C.blue }}>{t("notif.retry")}</button>
              </div>
            )}

            {!state.loading && !state.error && !state.items.length && (
              <div className="px-4 py-8 text-center">
                <CheckCircle2 size={22} color={C.green} className="mx-auto" />
                <div className="text-sm font-medium mt-2" style={{ color: C.charcoal }}>{t("notif.empty")}</div>
                <div className="text-xs mt-0.5" style={{ color: C.textMuted }}>{t("notif.emptyDesc")}</div>
              </div>
            )}

            {state.items.map((n) => {
              const { title, body } = describeNotification(n, t, locale);
              const Icon = KIND_ICON[n.kind] || Bell;
              const tone = TONE[n.severity] || TONE.blue;
              return (
                <button
                  key={n.key}
                  onClick={() => openItem(n, close)}
                  className="w-full flex items-start gap-3 px-4 py-3 text-left outline-none hover:bg-[var(--grey-bg)] focus:bg-[var(--grey-bg)]"
                  style={{ borderBottom: `1px solid ${C.greyBorderSoft}`, opacity: n.read ? 0.65 : 1 }}
                >
                  <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: tone.bg }}>
                    <Icon size={15} color={tone.fg} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="text-sm font-semibold truncate" style={{ color: C.charcoal }}>{title}</span>
                      {!n.read && <span aria-label={t("notif.unread")} className="w-2 h-2 rounded-full shrink-0" style={{ background: C.blue }} />}
                    </span>
                    <span className="block text-xs mt-0.5 break-words" style={{ color: C.textSecondary }}>{body}</span>
                    {n.createdAt && <span className="block text-[11px] mt-1" style={{ color: C.textMuted }}>{timeAgo(n.createdAt, locale)}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Popover>
  );
}

export default NotificationBell;
