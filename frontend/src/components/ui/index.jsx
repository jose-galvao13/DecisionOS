import React from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ArrowDownRight, Info, MoreHorizontal, Loader2 } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";

function Pill({ tone = "neutral", children }) {
  const map = {
    neutral: { bg: C.greyBg, fg: C.textSecondary }, green: { bg: C.greenSoft, fg: C.green },
    red: { bg: C.redSoft, fg: C.red }, yellow: { bg: C.yellowSoft, fg: C.yellow }, blue: { bg: C.blueSoft, fg: C.blue },
  }[tone];
  return <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium" style={{ background: map.bg, color: map.fg }}>{children}</span>;
}
function Card({ children, className = "", style = {} }) {
  return <div className={`rounded-2xl ${className}`} style={{ background: C.surface, border: `1px solid ${C.greyBorder}`, ...style }}>{children}</div>;
}
function KPI({ label, value, delta, deltaTone, sub }) {
  const up = deltaTone === "green";
  return (
    <Card className="p-5 flex-1 min-w-[190px]">
      <div className="text-sm" style={{ color: C.textSecondary }}>{label}</div>
      <div className="mt-2 tabnum text-3xl font-semibold" style={{ color: C.charcoal }}>{value}</div>
      <div className="mt-2 flex items-center gap-1.5">
        {delta != null && (
          <span className="inline-flex items-center gap-0.5 text-sm font-medium" style={{ color: deltaTone === "green" ? C.green : deltaTone === "red" ? C.red : C.textSecondary }}>
            {up ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}{delta}
          </span>
        )}
        {sub && <span className="text-sm" style={{ color: C.textMuted }}>{sub}</span>}
      </div>
    </Card>
  );
}
function SectionTitle({ eyebrow, title, desc }) {
  return (
    <div className="mb-5">
      {eyebrow && <div className="text-sm font-medium mb-1" style={{ color: C.blue }}>{eyebrow}</div>}
      <h1 className="text-2xl font-semibold" style={{ color: C.charcoal }}>{title}</h1>
      {desc && <p className="mt-1 text-sm" style={{ color: C.textSecondary }}>{desc}</p>}
    </div>
  );
}
function SourceBadge({ sourceInfo }) {
  const { t } = useLang();
  return (
    <div className="flex items-center gap-2 text-xs mb-5 px-3 py-2 rounded-lg w-fit" style={{ background: C.blueSoft, color: C.blue }}>
      <Info size={13} />
      {sourceInfo.type === "demo"
        ? t("source.demo")
        : t("source.fromFile", { name: sourceInfo.name, rows: sourceInfo.rows })}
    </div>
  );
}


// FASE 8 — progress indicator for async import/refresh jobs. `stage` is
// one of the worker's stage names (queued/connecting/fetching/validating/
// importing/analytics/completed/failed); `stageLabels` lets each caller
// supply translated copy without this component knowing about i18n.
function JobProgress({ progress = 0, stage, stageLabels = {} }) {
  const label = stageLabels[stage] || stage || "";
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5 text-sm">
        <span style={{ color: C.charcoal }}>{label}</span>
        <span className="tabnum" style={{ color: C.textMuted }}>{Math.round(progress)}%</span>
      </div>
      <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: C.greyBg }}>
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${Math.max(4, Math.min(100, progress))}%`, background: C.blue }}
        />
      </div>
    </div>
  );
}

// FASE 10 — lightweight toast system. ToastProvider holds the queue,
// useToast() lets any component push one, ToastViewport renders it fixed
// bottom-right and auto-dismisses. No external dep — this app has no
// toast/notification primitive today (errors are shown as inline banners
// scattered per-page), so this is the first shared one.
const ToastContext = React.createContext(null);
function ToastProvider({ children }) {
  const [toasts, setToasts] = React.useState([]);
  const push = React.useCallback((toast) => {
    const id = Math.random().toString(36).slice(2);
    const tone = toast.tone || "neutral";
    setToasts((t) => [...t, { id, tone, message: toast.message, duration: toast.duration ?? 4000 }]);
    return id;
  }, []);
  const dismiss = React.useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const api = React.useMemo(
    () => ({
      push,
      dismiss,
      success: (message, opts) => push({ message, tone: "green", ...opts }),
      error: (message, opts) => push({ message, tone: "red", ...opts }),
      info: (message, opts) => push({ message, tone: "blue", ...opts }),
    }),
    [push, dismiss]
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
function ToastViewport({ toasts, onDismiss }) {
  React.useEffect(() => {
    const timers = toasts.map((t) => setTimeout(() => onDismiss(t.id), t.duration));
    return () => timers.forEach(clearTimeout);
  }, [toasts, onDismiss]);
  if (!toasts.length) return null;
  const toneMap = {
    green: { bg: C.greenSoft, fg: C.green }, red: { bg: C.redSoft, fg: C.red },
    blue: { bg: C.blueSoft, fg: C.blue }, neutral: { bg: C.charcoal, fg: C.surface },
  };
  return (
    <div className="fixed bottom-5 right-5 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => {
        const tone = toneMap[t.tone] || toneMap.neutral;
        return (
          <div
            key={t.id}
            role="status"
            onClick={() => onDismiss(t.id)}
            className="px-4 py-3 rounded-xl shadow-lg text-sm cursor-pointer"
            style={{ background: tone.bg, color: tone.fg }}
          >
            {t.message}
          </div>
        );
      })}
    </div>
  );
}

// FASE 10 — minimal tooltip: no positioning library, just a hover bubble.
// Two problems the first version had (both visible on the simulator's "stated
// assumption" info icon):
//  1. Colors: the bubble used C.charcoal as background and C.white as text.
//     In dark mode charcoal turns light and white stays white -> white text on
//     a pale bubble. It now uses its own tooltip tokens (see lib/theme.jsx).
//  2. Size/position: `whitespace-nowrap` + centered on the trigger meant long
//     explanations were one very long line that ran off the left/right edge of
//     the window. The bubble is now capped in width, wraps, is drawn in a
//     portal with fixed positioning (so no ancestor's overflow can clip it)
//     and is clamped to the viewport.
const TOOLTIP_MARGIN = 8;
const TOOLTIP_MAX_WIDTH = 288;

function Tooltip({ label, children }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null); // { left, top, placement }
  const triggerRef = React.useRef(null);
  const bubbleRef = React.useRef(null);
  const id = React.useId();

  const place = React.useCallback(() => {
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const t = trigger.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const above = t.top - b.height - TOOLTIP_MARGIN >= TOOLTIP_MARGIN; // room above? else flip below
    const top = above ? t.top - b.height - TOOLTIP_MARGIN : t.bottom + TOOLTIP_MARGIN;
    let left = t.left + t.width / 2 - b.width / 2;
    left = Math.max(TOOLTIP_MARGIN, Math.min(left, vw - b.width - TOOLTIP_MARGIN));
    setPos({ left, top });
  }, []);

  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => { window.removeEventListener("scroll", place, true); window.removeEventListener("resize", place); };
  }, [open, label, place]);

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex"
      aria-describedby={open ? id : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && createPortal(
        <span
          ref={bubbleRef}
          id={id}
          role="tooltip"
          className="fixed z-[100] px-3 py-2 rounded-lg text-xs leading-snug shadow-lg pointer-events-none"
          style={{
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            width: "max-content",
            maxWidth: `min(${TOOLTIP_MAX_WIDTH}px, calc(100vw - ${TOOLTIP_MARGIN * 2}px))`,
            visibility: pos ? "visible" : "hidden", // measured first, shown once placed
            background: C.tooltipBg,
            color: C.tooltipFg,
            border: `1px solid ${C.tooltipBorder}`,
          }}
        >
          {label}
        </span>,
        document.body
      )}
    </span>
  );
}

// "⋯" button that opens a small menu of actions (rename, export, remove…).
// Drawn in a portal with fixed positioning — like Tooltip — so a card with
// overflow:hidden can't clip it, and it flips upwards near the bottom of the
// window. Closes on Esc, outside click, scroll, resize or after choosing.
// items: [{ key, label, icon, onSelect, danger?, disabled?, hidden?, separatorBefore? }]
const MENU_MARGIN = 8;

function ActionMenu({ label, items, busy = false, disabled = false }) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState(null);
  const buttonRef = React.useRef(null);
  const menuRef = React.useRef(null);
  const visible = items.filter((i) => !i.hidden);

  const close = React.useCallback((returnFocus = false) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  React.useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const b = buttonRef.current.getBoundingClientRect();
    const m = menuRef.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const below = b.bottom + 6 + m.height <= vh - MENU_MARGIN;
    const top = below ? b.bottom + 6 : Math.max(MENU_MARGIN, b.top - 6 - m.height);
    const left = Math.max(MENU_MARGIN, Math.min(b.right - m.width, vw - m.width - MENU_MARGIN)); // right edges aligned
    setPos({ top, left });
  }, [open]);

  // Focus the first item once the menu is actually visible (a visibility:hidden
  // element can't take focus, so this can't happen in the layout effect above).
  const placed = pos !== null;
  React.useEffect(() => {
    if (open && placed) menuRef.current?.querySelector("button:not([disabled])")?.focus();
  }, [open, placed]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (!menuRef.current?.contains(e.target) && !buttonRef.current?.contains(e.target)) close();
    };
    const onScrollOrResize = () => close();
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, close]);

  const onMenuKeyDown = (e) => {
    const buttons = [...menuRef.current.querySelectorAll("button:not([disabled])")];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); close(true); }
    else if (e.key === "Tab") close();
    else if (e.key === "ArrowDown") { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); buttons[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); buttons[buttons.length - 1]?.focus(); }
  };

  if (!visible.length) return null;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="p-2 rounded-lg disabled:opacity-50"
        style={{ border: `1px solid ${C.greyBorder}`, color: C.textSecondary, background: open ? C.greyBg : "transparent" }}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <MoreHorizontal size={14} />}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className="fixed z-[90] min-w-[200px] py-1.5 rounded-xl shadow-lg"
          style={{
            top: pos?.top ?? 0, left: pos?.left ?? 0,
            visibility: pos ? "visible" : "hidden", // measured first, shown once placed
            background: C.surface, border: `1px solid ${C.greyBorder}`,
          }}
        >
          {visible.map((item) => {
            const Icon = item.icon;
            return (
              <React.Fragment key={item.key}>
                {item.separatorBefore && <div className="my-1.5" role="separator" style={{ borderTop: `1px solid ${C.greyBorderSoft}` }} />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => { close(); item.onSelect(); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left outline-none disabled:opacity-40 hover:bg-[var(--grey-bg)] focus:bg-[var(--grey-bg)]"
                  style={{ color: item.danger ? C.red : C.charcoal }}
                >
                  {Icon && <Icon size={15} />}
                  {item.label}
                </button>
              </React.Fragment>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

// FASE 10 — consistent empty/error state block, so every page stops
// hand-rolling its own centered icon+text layout (Overview, DataQuality,
// DataSources, etc. each did their own slightly different version).
function EmptyState({ icon: Icon = Info, title, desc, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-12 h-12 rounded-2xl flex items-center justify-center mb-4" style={{ background: C.greyBg }}>
        <Icon size={20} color={C.textMuted} />
      </div>
      {title && <div className="font-semibold" style={{ color: C.charcoal }}>{title}</div>}
      {desc && <p className="mt-1.5 text-sm max-w-sm" style={{ color: C.textSecondary }}>{desc}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

function Modal({ children, wide, narrow }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6" style={{ background: "rgba(10,21,38,0.6)" }}>
      <div className={`w-full ${narrow ? "max-w-md" : wide ? "max-w-3xl" : "max-w-2xl"} rounded-3xl overflow-hidden`} style={{ background: C.surface }}>{children}</div>
    </div>
  );
}


export { Pill, Card, KPI, SectionTitle, SourceBadge, Modal, JobProgress, ToastProvider, useToast, Tooltip, EmptyState, ActionMenu };
