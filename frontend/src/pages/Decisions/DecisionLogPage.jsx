import React, { useState, useEffect, useCallback } from "react";
import { CheckCircle2, XCircle, PlayCircle, Archive, Loader2, TrendingUp, User, Send, ListChecks, Plus, Sparkles } from "lucide-react";
import { C, tint } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch } from "../../api/client";
import { Card, SectionTitle, EmptyState, useToast } from "../../components/ui";

/* ---------------------------------------------------------------
   DECISION LOG — P1 ("Decision creation", "Decision history",
   "Decision owner", "Approval workflow", "Expected vs actual
   outcome", "Decision ROI").

   This is the DECIDE -> ACT -> MEASURE -> LEARN half of the product
   loop (backend/src/services/decisionRecords.js). Decisions land
   here from three places: the Decision Feed ("Turn into a decision"
   on Overview), the Simulator ("Commit this scenario as a decision"),
   or created manually from this page.
----------------------------------------------------------------*/

// Mirrors backend/src/auth/middleware.js's ROLE_RANK — kept in sync by
// hand since this is the only frontend page that needs role-gated
// actions; approve/reject/outcome all also re-check server-side
// regardless, this is only for hiding buttons a click would 403 on.
const ROLE_RANK = { viewer: 0, manager: 1, finance: 2, admin: 3, owner: 4 };
const canApprove = (role) => (ROLE_RANK[role] ?? -1) >= ROLE_RANK.manager;

const STATUS_META = {
  proposed: { label: "Proposed", color: C.textMuted },
  pending_approval: { label: "Pending approval", color: C.yellow },
  approved: { label: "Approved", color: C.blue },
  rejected: { label: "Rejected", color: C.red },
  in_progress: { label: "In progress", color: C.blue },
  completed: { label: "Completed", color: C.green },
  archived: { label: "Archived", color: C.textMuted },
};

const STATUS_FILTERS = ["all", "proposed", "pending_approval", "approved", "in_progress", "completed", "rejected", "archived"];

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, color: C.textMuted };
  return (
    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: tint(meta.color), color: meta.color }}>
      {meta.label}
    </span>
  );
}

function OutcomeForm({ decision, onSubmit, busy }) {
  const [value, setValue] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <div className="mt-3 p-3 rounded-lg" style={{ background: C.greyBg }}>
      <div className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: C.textMuted }}>Record actual outcome</div>
      <div className="flex gap-2 mb-2">
        <input
          type="number" placeholder="Actual value (€)" value={value} onChange={(e) => setValue(e.target.value)}
          className="flex-1 px-3 py-2 rounded-lg text-sm" style={{ border: `1px solid ${C.greyBorder}` }}
        />
        <button
          disabled={busy || !value}
          onClick={() => onSubmit({ value: Number(value), notes })}
          className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50"
          style={{ background: C.blue }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : "Save"}
        </button>
      </div>
      <input
        placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)}
        className="w-full px-3 py-2 rounded-lg text-sm" style={{ border: `1px solid ${C.greyBorder}` }}
      />
      {decision.expected_impact && (
        <p className="text-xs mt-2" style={{ color: C.textMuted }}>
          Expected: {decision.expected_impact.currency} {decision.expected_impact.low?.toLocaleString()} – {decision.expected_impact.high?.toLocaleString()}
        </p>
      )}
    </div>
  );
}

const ACTION_STATUS_CYCLE = { todo: "in_progress", in_progress: "done", done: "todo", skipped: "todo" };
const ACTION_STATUS_META = {
  todo: { label: "To do", color: C.textMuted },
  in_progress: { label: "In progress", color: C.blue },
  done: { label: "Done", color: C.green },
  skipped: { label: "Skipped", color: C.textMuted },
};

/** P2 "Decision -> Action": a decision's own checklist, loaded lazily
 *  (only once expanded) so a Decision Log with dozens of decisions
 *  doesn't fire dozens of extra requests on page load. */
function ActionsPanel({ decisionId }) {
  const [actions, setActions] = useState(null); // null = not loaded yet
  const [newTitle, setNewTitle] = useState("");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [orgUsers, setOrgUsers] = useState(null); // null = not loaded / no permission to list
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    apiFetch(`/api/decision-log/${decisionId}/actions`).then(setActions).catch((e) => toast.error(e.message));
  }, [decisionId, toast]);

  useEffect(() => { load(); }, [load]);

  // GET /api/org/users is admin+ only (it's the same roster used to manage
  // roles) — most people who can add an action aren't admins, so this is
  // a nice-to-have, not a requirement: if it 403s, the picker just stays
  // hidden and actions can still be created unassigned.
  useEffect(() => {
    apiFetch("/api/org/users").then((r) => setOrgUsers(r.users || [])).catch(() => {});
  }, []);

  const addAction = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    try {
      await apiFetch(`/api/decision-log/${decisionId}/actions`, { method: "POST", body: { title: newTitle.trim(), ownerId: newOwnerId || undefined } });
      setNewTitle("");
      setNewOwnerId("");
      load();
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };

  const cycleStatus = async (action) => {
    try {
      await apiFetch(`/api/decision-log/${decisionId}/actions/${action.id}`, { method: "PATCH", body: { status: ACTION_STATUS_CYCLE[action.status] } });
      load();
    } catch (e) { toast.error(e.message); }
  };

  const remove = async (actionId) => {
    try {
      await apiFetch(`/api/decision-log/${decisionId}/actions/${actionId}`, { method: "DELETE" });
      load();
    } catch (e) { toast.error(e.message); }
  };

  if (actions === null) {
    return <div className="text-xs py-2 flex items-center gap-1" style={{ color: C.textMuted }}><Loader2 size={12} className="animate-spin" /> Loading actions…</div>;
  }

  return (
    <div className="mt-2 pt-2" style={{ borderTop: `1px solid ${C.greyBorder}` }}>
      {actions.length === 0 && <p className="text-xs mb-2" style={{ color: C.textMuted }}>No actions yet — break this decision into concrete steps.</p>}
      {actions.map((a) => {
        const meta = ACTION_STATUS_META[a.status] || ACTION_STATUS_META.todo;
        const ownerName = a.owner_id && orgUsers?.find((u) => u.id === a.owner_id)?.name;
        return (
          <div key={a.id} className="flex items-center gap-2 text-xs py-1">
            <button onClick={() => cycleStatus(a)} className="flex items-center gap-1.5" style={{ color: meta.color }} title="Click to advance status">
              <CheckCircle2 size={13} style={{ opacity: a.status === "done" ? 1 : 0.3 }} />
              <span className={a.status === "done" ? "line-through" : ""} style={{ color: a.status === "done" ? C.textMuted : C.charcoal }}>{a.title}</span>
            </button>
            {ownerName && <span className="flex items-center gap-0.5" style={{ color: C.textMuted }}><User size={11} /> {ownerName}</span>}
            <span className="ml-auto px-1.5 py-0.5 rounded" style={{ background: tint(meta.color), color: meta.color, fontSize: 10 }}>{meta.label}</span>
            <button onClick={() => remove(a.id)} className="opacity-50 hover:opacity-100" style={{ color: C.red }}><XCircle size={13} /></button>
          </div>
        );
      })}
      <div className="flex gap-1.5 mt-1.5">
        <input
          value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Add an action…"
          onKeyDown={(e) => e.key === "Enter" && addAction()}
          className="flex-1 px-2 py-1 rounded text-xs" style={{ border: `1px solid ${C.greyBorder}` }}
        />
        {orgUsers && orgUsers.length > 0 && (
          <select value={newOwnerId} onChange={(e) => setNewOwnerId(e.target.value)} className="px-1.5 py-1 rounded text-xs" style={{ border: `1px solid ${C.greyBorder}` }}>
            <option value="">Unassigned</option>
            {orgUsers.map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
          </select>
        )}
        <button disabled={busy || !newTitle.trim()} onClick={addAction} className="px-2 py-1 rounded text-xs font-medium text-white disabled:opacity-50" style={{ background: C.charcoal }}>
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

function DecisionCard({ decision, currentUser, onAction }) {
  const [busy, setBusy] = useState(false);
  const [showOutcomeForm, setShowOutcomeForm] = useState(false);
  const [showActions, setShowActions] = useState(false);
  const toast = useToast();

  const run = async (action, ...args) => {
    setBusy(true);
    try {
      await onAction(decision.id, action, ...args);
      setShowOutcomeForm(false);
    } catch (e) {
      toast.error(e.message || "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const canAct = canApprove(currentUser?.role);

  return (
    <Card className="p-4 mb-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold text-sm" style={{ color: C.charcoal }}>{decision.title}</span>
            <StatusBadge status={decision.status} />
            {decision.confidence != null && (
              <span className="text-[11px] px-1.5 py-0.5 rounded" style={{ background: C.greyBg, color: C.textMuted }}>{decision.confidence}% confidence</span>
            )}
          </div>
          <p className="text-sm" style={{ color: C.charcoal }}>{decision.description}</p>
          {decision.recommendation && <p className="text-xs mt-1" style={{ color: C.textSecondary }}>→ {decision.recommendation}</p>}
          <div className="flex items-center gap-3 mt-2 text-xs" style={{ color: C.textMuted }}>
            {decision.owner_id && <span className="flex items-center gap-1"><User size={11} /> Owner assigned</span>}
            {decision.target_date && <span>Target: {decision.target_date}</span>}
            {decision.expected_impact && (
              <span>Expected: {decision.expected_impact.currency} {decision.expected_impact.low?.toLocaleString()}–{decision.expected_impact.high?.toLocaleString()}</span>
            )}
          </div>

          {decision.actual_outcome && (
            <div className="mt-2 p-2 rounded-lg text-xs" style={{ background: C.greenSoft, color: C.charcoal }}>
              <div className="flex items-center gap-1 font-semibold" style={{ color: C.green }}>
                <TrendingUp size={12} /> Actual outcome: {decision.actual_outcome.currency} {decision.actual_outcome.value?.toLocaleString()}
                {decision.outcome_source === "automatic" && (
                  <span className="flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded-full font-normal" style={{ background: tint(C.blue), color: C.blue, fontSize: 10 }}>
                    <Sparkles size={9} /> measured automatically
                  </span>
                )}
              </div>
              {decision.actual_outcome.notes && decision.outcome_source === "automatic" && (
                <p className="mt-0.5" style={{ color: C.textMuted }}>{decision.actual_outcome.notes}</p>
              )}
              {decision.variance && decision.variance.withinExpectedRange != null && (
                <div className="mt-0.5">{decision.variance.withinExpectedRange ? "✓ Within expected range" : "⚠ Outside expected range"} ({decision.variance.deltaVsMidpoint >= 0 ? "+" : ""}{decision.variance.deltaVsMidpoint?.toLocaleString()} vs. midpoint)</div>
              )}
              {decision.roi && (
                <div className="mt-0.5 font-semibold">ROI: {decision.roi.roiPct >= 0 ? "+" : ""}{decision.roi.roiPct}% (net {decision.roi.netGain >= 0 ? "+" : ""}{decision.roi.netGain?.toLocaleString()})</div>
              )}
            </div>
          )}

          {["approved", "in_progress", "completed"].includes(decision.status) && (
            <button onClick={() => setShowActions((s) => !s)} className="flex items-center gap-1 mt-2 text-xs font-medium" style={{ color: C.textSecondary }}>
              <ListChecks size={12} /> {showActions ? "Hide actions" : "Actions"}
            </button>
          )}
          {showActions && <ActionsPanel decisionId={decision.id} />}
        </div>

        <div className="flex flex-col gap-1.5 shrink-0">
          {decision.status === "proposed" && (
            <button disabled={busy} onClick={() => run("submit")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: C.blue }}>
              <Send size={12} /> Submit
            </button>
          )}
          {decision.status === "pending_approval" && canAct && (
            <>
              <button disabled={busy} onClick={() => run("approve")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: C.green }}>
                <CheckCircle2 size={12} /> Approve
              </button>
              <button disabled={busy} onClick={() => run("reject", "Not approved")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium" style={{ border: `1px solid ${C.red}`, color: C.red }}>
                <XCircle size={12} /> Reject
              </button>
            </>
          )}
          {decision.status === "approved" && (
            <button disabled={busy} onClick={() => run("start")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: C.blue }}>
              <PlayCircle size={12} /> Start
            </button>
          )}
          {decision.status === "in_progress" && canAct && !decision.actual_outcome && (
            <button disabled={busy} onClick={() => setShowOutcomeForm((s) => !s)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-white" style={{ background: C.charcoal }}>
              <TrendingUp size={12} /> Record outcome
            </button>
          )}
          {!["archived", "completed"].includes(decision.status) && (
            <button disabled={busy} onClick={() => run("archive")} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs" style={{ color: C.textMuted }}>
              <Archive size={12} /> Archive
            </button>
          )}
        </div>
      </div>

      {showOutcomeForm && <OutcomeForm decision={decision} busy={busy} onSubmit={(payload) => run("outcome", payload)} />}
    </Card>
  );
}

export default function DecisionLogPage({ user }) {
  const { t } = useLang();
  const [decisions, setDecisions] = useState([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    const qs = statusFilter !== "all" ? `?status=${statusFilter}` : "";
    apiFetch(`/api/decision-log${qs}`)
      .then((data) => { setDecisions(data.decisions || []); setTotal(data.total || 0); setError(""); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const handleAction = async (id, action, payload) => {
    const endpoints = {
      submit: { method: "POST", path: `/${id}/submit` },
      approve: { method: "POST", path: `/${id}/approve` },
      reject: { method: "POST", path: `/${id}/reject`, body: { reason: payload } },
      start: { method: "POST", path: `/${id}/start` },
      archive: { method: "POST", path: `/${id}/archive` },
      outcome: { method: "POST", path: `/${id}/outcome`, body: payload },
    };
    const ep = endpoints[action];
    await apiFetch(`/api/decision-log${ep.path}`, { method: ep.method, body: ep.body });
    load();
  };

  return (
    <div>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <SectionTitle eyebrow="DECIDE → ACT → MEASURE" title="Decision Log" desc="Decisions your org has actually made — who owns them, whether they were approved, and what actually happened." />
        {canApprove(user?.role) && (
          <button
            disabled={measuring}
            onClick={async () => {
              setMeasuring(true);
              try {
                const r = await apiFetch("/api/decision-log/measure-due", { method: "POST" });
                toast.success(`Checked ${r.checked}, measured ${r.measured} automatically, ${r.skipped} left for manual review.`);
                load();
              } catch (e) { toast.error(e.message); } finally { setMeasuring(false); }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white shrink-0"
            style={{ background: C.charcoal }}
            title="Checks every decision whose measurement window has elapsed and records an automatic outcome from real transaction data where possible"
          >
            {measuring ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Measure due decisions now
          </button>
        )}
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className="px-3 py-1.5 rounded-full text-xs font-medium"
            style={{
              background: statusFilter === s ? C.blue : C.greyBg,
              color: statusFilter === s ? C.white : C.textSecondary,
            }}
          >
            {s === "all" ? "All" : (STATUS_META[s]?.label || s)}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-sm py-8 justify-center" style={{ color: C.textMuted }}>
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      )}

      {!loading && error && <EmptyState title="Couldn't load decisions" desc={error} />}

      {!loading && !error && decisions.length === 0 && (
        <EmptyState
          title="No decisions here yet"
          desc="Turn a detected decision (Overview) or a simulation (Decision Simulator) into a tracked decision to start building your decision history."
        />
      )}

      {!loading && decisions.map((d) => (
        <DecisionCard key={d.id} decision={d} currentUser={user} onAction={handleAction} />
      ))}

      {total > decisions.length && (
        <div className="text-center text-xs mt-2" style={{ color: C.textMuted }}>Showing {decisions.length} of {total}</div>
      )}
    </div>
  );
}
