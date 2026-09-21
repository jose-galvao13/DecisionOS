import React from "react";
import { UserPlus, Loader2, Copy, Check, X, KeyRound, UserX, UserCheck } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch } from "../../api/client";
import { ASSIGNABLE_ROLES, canManageMember, initialsOf } from "../../lib/roles";
import { Card, Pill, Modal, ActionMenu, useToast } from "../../components/ui";
import PasswordField from "../../components/PasswordField";

const inputStyle = { border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface };
const inputClass = "w-full text-sm px-3 py-2.5 rounded-xl outline-none";
const MIN_PASSWORD = 8;

function Field({ id, label, children }) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium mb-1.5" style={{ color: C.textSecondary }}>{label}</label>
      {children}
    </div>
  );
}

/* ---- Credentials to hand over, shown once right after creating someone ---- */
function CredentialsNotice({ created, onClose }) {
  const { t } = useLang();
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${t("team.add.email")}: ${created.email}\n${t("team.add.password")}: ${created.password}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* blocked: the values are on screen and can be selected */ }
  };
  return (
    <div role="status" aria-label={t("team.creds.title", { name: created.name })} className="mt-4 p-4 rounded-xl" style={{ background: C.greenSoft, border: `1px solid ${C.green}` }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold" style={{ color: C.green }}>{t("team.creds.title", { name: created.name })}</div>
          <div className="text-xs mt-0.5" style={{ color: C.textSecondary }}>{t("team.creds.desc")}</div>
        </div>
        <button onClick={onClose} aria-label={t("team.creds.close")} className="p-1 rounded-lg shrink-0" style={{ color: C.textSecondary }}><X size={14} /></button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3 text-sm">
        <dt style={{ color: C.textSecondary }}>{t("team.add.email")}</dt>
        <dd className="font-medium break-all" style={{ color: C.charcoal }}>{created.email}</dd>
        <dt style={{ color: C.textSecondary }}>{t("team.add.password")}</dt>
        <dd className="font-mono font-medium break-all" style={{ color: C.charcoal }}>{created.password}</dd>
      </dl>
      <button onClick={copy} className="mt-3 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }}>
        {copied ? <Check size={13} color={C.green} /> : <Copy size={13} />} {copied ? t("pw.copied") : t("team.creds.copy")}
      </button>
    </div>
  );
}

/* ---- Add a team member ---- */
function AddMemberCard({ me, onCreated }) {
  const { t } = useLang();
  const toast = useToast();
  const roles = me.role === "owner" ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter((r) => r !== "admin"); // only an owner creates admins
  const [form, setForm] = React.useState({ name: "", email: "", password: "", role: "viewer" });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");
  const [created, setCreated] = React.useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (form.password.length < MIN_PASSWORD) return setError(t("pw.tooShort"));
    setSaving(true);
    try {
      const res = await apiFetch("/api/org/users", { method: "POST", body: { name: form.name.trim(), email: form.email.trim(), password: form.password, role: form.role } });
      setCreated({ name: res.name, email: res.email, password: form.password });
      setForm((f) => ({ name: "", email: "", password: "", role: f.role }));
      toast.success(t("team.add.success", { name: res.name }));
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-1">
        <UserPlus size={16} color={C.blue} />
        <h2 className="text-base font-semibold" style={{ color: C.charcoal }}>{t("team.add.title")}</h2>
      </div>
      <p className="text-sm mb-4" style={{ color: C.textSecondary }}>{t("team.add.desc")}</p>

      <form onSubmit={submit} className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Field id="tm-name" label={t("team.add.name")}>
          <input id="tm-name" required maxLength={100} value={form.name} onChange={(e) => set({ name: e.target.value })} autoComplete="off" disabled={saving} className={inputClass} style={inputStyle} />
        </Field>
        <Field id="tm-email" label={t("team.add.email")}>
          <input id="tm-email" required type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} autoComplete="off" disabled={saving} className={inputClass} style={inputStyle} />
        </Field>
        <PasswordField id="tm-password" label={t("team.add.password")} value={form.password} onChange={(v) => set({ password: v })} hint={t("pw.hint")} generate copy disabled={saving} />
        <div>
          <Field id="tm-role" label={t("team.add.role")}>
            <select id="tm-role" value={form.role} onChange={(e) => set({ role: e.target.value })} disabled={saving} className={inputClass} style={inputStyle}>
              {roles.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
            </select>
          </Field>
          <div className="text-xs mt-1.5" style={{ color: C.textMuted }}>{t(`role.help.${form.role}`)}</div>
        </div>

        {error && <div role="alert" className="col-span-2 px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>{error}</div>}
        <div className="col-span-2">
          <button
            type="submit"
            disabled={saving || !form.name.trim() || !form.email.trim() || !form.password}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50"
            style={{ background: C.blue, color: C.white }}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} {t("team.add.submit")}
          </button>
        </div>
      </form>

      {created && <CredentialsNotice created={created} onClose={() => setCreated(null)} />}
    </Card>
  );
}

/* ---- Reset someone's password ---- */
function ResetPasswordModal({ member, onClose, onDone }) {
  const { t } = useLang();
  const [password, setPassword] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (password.length < MIN_PASSWORD) return setError(t("pw.tooShort"));
    setSaving(true);
    try {
      await apiFetch(`/api/org/users/${member.id}/reset-password`, { method: "POST", body: { password } });
      onDone();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal narrow>
      <form role="dialog" aria-modal="true" aria-label={t("team.reset.title", { name: member.name })} onSubmit={submit} className="p-6 space-y-4">
        <div>
          <h2 className="text-base font-semibold" style={{ color: C.charcoal }}>{t("team.reset.title", { name: member.name })}</h2>
          <p className="text-sm mt-1" style={{ color: C.textSecondary }}>{t("team.reset.desc")}</p>
        </div>
        <PasswordField id="reset-password" label={t("team.add.password")} value={password} onChange={setPassword} hint={t("pw.hint")} generate copy disabled={saving} />
        {error && <div role="alert" className="px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 rounded-xl text-sm font-medium" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }}>{t("data.cancel")}</button>
          <button type="submit" disabled={saving || !password} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium disabled:opacity-50" style={{ background: C.blue, color: C.white }}>
            {saving && <Loader2 size={14} className="animate-spin" />} {t("team.reset.submit")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---- Members list ---- */
function MemberRow({ me, member, busy, onRoleChange, onReset, onToggle }) {
  const { t, locale } = useLang();
  const isMe = member.id === me.id;
  const manageable = canManageMember(me, member);
  const disabled = !!member.disabled_at;
  const canEditRole = me.role === "owner" && manageable; // the backend only lets an owner change roles
  const since = new Date(member.created_at);

  return (
    <div data-testid="member-row" className="flex items-center justify-between gap-3 p-4 rounded-xl" style={{ border: `1px solid ${C.greyBorder}`, opacity: disabled ? 0.7 : 1 }}>
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-full flex items-center justify-center text-xs font-semibold text-white shrink-0" style={{ background: disabled ? C.textMuted : C.blueDark }}>
          {initialsOf(member.name)}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold truncate" style={{ color: C.charcoal }}>{member.name}</span>
            {isMe && <Pill tone="blue">{t("team.you")}</Pill>}
            {disabled && <Pill tone="red">{t("team.deactivated")}</Pill>}
          </div>
          <div className="text-sm truncate" style={{ color: C.textSecondary }}>
            {member.email}{!Number.isNaN(since.getTime()) && <> · {t("team.since", { date: since.toLocaleDateString(locale) })}</>}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {canEditRole ? (
          <select
            aria-label={t("team.roleFor", { name: member.name })}
            value={member.role}
            disabled={busy}
            onChange={(e) => onRoleChange(member, e.target.value)}
            className="text-sm px-2.5 py-2 rounded-lg outline-none"
            style={inputStyle}
          >
            {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
          </select>
        ) : (
          <Pill tone="neutral">{t(`role.${member.role}`)}</Pill>
        )}
        <ActionMenu
          label={t("team.moreFor", { name: member.name })}
          busy={busy}
          disabled={busy}
          items={[
            { key: "reset", label: t("team.action.reset"), icon: KeyRound, onSelect: () => onReset(member), hidden: !manageable },
            { key: "toggle", label: disabled ? t("team.action.reactivate") : t("team.action.deactivate"), icon: disabled ? UserCheck : UserX, onSelect: () => onToggle(member), danger: !disabled, hidden: !manageable },
          ]}
        />
      </div>
    </div>
  );
}

function TeamPanel({ user }) {
  const { t } = useLang();
  const toast = useToast();
  const [members, setMembers] = React.useState(null);
  const [error, setError] = React.useState("");
  const [busyId, setBusyId] = React.useState(null);
  const [resetFor, setResetFor] = React.useState(null);

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch("/api/org/users");
      setMembers(data.users);
      setError("");
    } catch (e) {
      setError(e.message || t("team.loadError"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => { load(); }, [load]);

  // One place for "call the server, say what happened, refresh the list".
  const act = async (member, request, successKey, vars = {}) => {
    setBusyId(member.id);
    try {
      await request();
      toast.success(t(successKey, { name: member.name, ...vars }));
      await load();
    } catch (e) {
      toast.error(e.message);
      await load(); // a failed change may still mean the list is out of date
    } finally {
      setBusyId(null);
    }
  };

  const changeRole = (member, role) =>
    act(member, () => apiFetch(`/api/org/users/${member.id}/role`, { method: "PATCH", body: { role } }), "team.toast.role", { role: t(`role.${role}`) });

  const toggleActive = (member) => {
    if (member.disabled_at) return act(member, () => apiFetch(`/api/org/users/${member.id}/reactivate`, { method: "POST" }), "team.toast.reactivated");
    if (!window.confirm(t("team.deactivate.confirm", { name: member.name }))) return;
    return act(member, () => apiFetch(`/api/org/users/${member.id}/deactivate`, { method: "POST" }), "team.toast.deactivated");
  };

  return (
    <div className="space-y-6">
      <AddMemberCard me={user} onCreated={load} />

      <Card className="p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold" style={{ color: C.charcoal }}>{t("team.members", { n: members ? members.length : "…" })}</h2>
          <p className="text-sm" style={{ color: C.textSecondary }}>{t("team.desc", { org: user.orgName || "—" })}</p>
        </div>

        {!members && !error && (
          <div className="flex items-center gap-2 text-sm" style={{ color: C.textMuted }}><Loader2 size={14} className="animate-spin" /> {t("notif.loading")}</div>
        )}
        {error && !members && (
          <div role="alert" className="px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>
            {error} <button onClick={load} className="underline ml-1">{t("notif.retry")}</button>
          </div>
        )}
        <div className="space-y-2.5">
          {members?.map((m) => (
            <MemberRow key={m.id} me={user} member={m} busy={busyId === m.id} onRoleChange={changeRole} onReset={setResetFor} onToggle={toggleActive} />
          ))}
        </div>
      </Card>

      {resetFor && (
        <ResetPasswordModal
          member={resetFor}
          onClose={() => setResetFor(null)}
          onDone={() => { toast.success(t("team.toast.reset", { name: resetFor.name })); setResetFor(null); }}
        />
      )}
    </div>
  );
}

export default TeamPanel;
