import React from "react";
import { Eye, EyeOff, Wand2, Copy, Check } from "lucide-react";
import { C } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { generatePassword } from "../lib/passwords";

/* Password input with show/hide, and optionally "generate" + "copy" (for the
   person handing an initial password to a new team member). */
function PasswordField({ id, label, value, onChange, autoComplete = "new-password", hint, generate = false, copy = false, disabled = false }) {
  const { t } = useLang();
  const [visible, setVisible] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const onGenerate = () => { onChange(generatePassword()); setVisible(true); }; // show it, otherwise nobody can read what was generated
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked: the password is visible, it can still be selected by hand */ }
  };
  const iconBtn = "p-2 rounded-lg shrink-0 disabled:opacity-40";
  const iconStyle = { border: `1px solid ${C.greyBorder}`, color: C.textSecondary };

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium mb-1.5" style={{ color: C.textSecondary }}>{label}</label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          disabled={disabled}
          className="min-w-0 flex-1 text-sm px-3 py-2.5 rounded-xl outline-none"
          style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal, background: C.surface }}
        />
        <button type="button" onClick={() => setVisible((v) => !v)} aria-label={visible ? t("pw.hide") : t("pw.show")} title={visible ? t("pw.hide") : t("pw.show")} className={iconBtn} style={iconStyle} disabled={disabled}>
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
        {generate && (
          <button type="button" onClick={onGenerate} disabled={disabled} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium shrink-0 disabled:opacity-40" style={iconStyle}>
            <Wand2 size={13} /> {t("pw.generate")}
          </button>
        )}
        {copy && (
          <button type="button" onClick={onCopy} disabled={!value || disabled} aria-label={t("pw.copy")} title={t("pw.copy")} className={iconBtn} style={iconStyle}>
            {copied ? <Check size={15} color={C.green} /> : <Copy size={15} />}
          </button>
        )}
      </div>
      {hint && <div className="text-xs mt-1.5" style={{ color: C.textMuted }}>{hint}</div>}
    </div>
  );
}

export default PasswordField;
