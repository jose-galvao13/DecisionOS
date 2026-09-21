import React from "react";
import { Loader2, KeyRound } from "lucide-react";
import { C } from "../../lib/theme";
import { useLang } from "../../lib/i18n";
import { apiFetch, setToken } from "../../api/client";
import { initialsOf } from "../../lib/roles";
import { Card, Pill, useToast } from "../../components/ui";
import PasswordField from "../../components/PasswordField";

function Fact({ label, children }) {
  return (
    <div className="p-3 rounded-xl" style={{ background: C.greyBg }}>
      <div className="text-xs" style={{ color: C.textSecondary }}>{label}</div>
      <div className="text-sm font-semibold mt-0.5 break-words" style={{ color: C.charcoal }}>{children}</div>
    </div>
  );
}

function ChangePasswordCard() {
  const { t } = useLang();
  const toast = useToast();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    if (next.length < 8) return setError(t("pw.tooShort"));
    if (next !== confirm) return setError(t("account.pw.mismatch"));
    setSaving(true);
    try {
      const res = await apiFetch("/api/auth/change-password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      // The server ended every other session of this account; this fresh token keeps *this* one signed in.
      if (res.token) setToken(res.token);
      setCurrent(""); setNext(""); setConfirm("");
      toast.success(t("account.pw.success"));
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-6">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound size={16} color={C.blue} />
        <h2 className="text-base font-semibold" style={{ color: C.charcoal }}>{t("account.pw.title")}</h2>
      </div>
      <p className="text-sm mb-4" style={{ color: C.textSecondary }}>{t("account.pw.desc")}</p>
      <form onSubmit={submit} className="space-y-3 max-w-md">
        <PasswordField id="pw-current" label={t("account.pw.current")} value={current} onChange={setCurrent} autoComplete="current-password" disabled={saving} />
        <PasswordField id="pw-new" label={t("account.pw.new")} value={next} onChange={setNext} hint={t("pw.hint")} disabled={saving} />
        <PasswordField id="pw-confirm" label={t("account.pw.confirm")} value={confirm} onChange={setConfirm} disabled={saving} />
        {error && <div role="alert" className="px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>{error}</div>}
        <button
          type="submit"
          disabled={saving || !current || !next || !confirm}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium disabled:opacity-50"
          style={{ background: C.blue, color: C.white }}
        >
          {saving && <Loader2 size={14} className="animate-spin" />} {t("account.pw.submit")}
        </button>
      </form>
    </Card>
  );
}

function ProfilePanel({ user }) {
  const { t } = useLang();
  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex items-center gap-4 mb-5">
          <div className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-semibold text-white shrink-0" style={{ background: C.blueDark }}>
            {initialsOf(user?.name)}
          </div>
          <div className="min-w-0">
            <div className="text-lg font-semibold truncate" style={{ color: C.charcoal }}>{user?.name}</div>
            <div className="text-sm truncate" style={{ color: C.textSecondary }}>{user?.email}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Fact label={t("account.field.org")}>{user?.orgName || "—"}</Fact>
          <Fact label={t("account.field.role")}><Pill tone="blue">{t(`role.${user?.role}`)}</Pill></Fact>
        </div>
        <p className="text-xs mt-3" style={{ color: C.textMuted }}>{t(`role.help.${user?.role}`)}</p>
      </Card>
      <ChangePasswordCard />
    </div>
  );
}

export default ProfilePanel;
