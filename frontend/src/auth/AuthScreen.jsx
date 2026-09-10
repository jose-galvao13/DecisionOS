import React, { useState } from "react";
import { Zap, Loader2 } from "lucide-react";
import { C, fontImport } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { apiFetch, setToken } from "../api/client";
import ThemeSwitch from "../components/ThemeSwitch";

/* ---------------------------------------------------------------
   AUTH — every /api/* route on the backend requires a Bearer JWT
   (see src/auth/middleware.js), except register/login themselves.
   AuthScreen gets that token; AuthGate holds it, verifies it against
   GET /api/auth/me on load, and renders either the login form or the
   real app. sourceInfo/analytics stay entirely inside DecisionOSApp —
   this component's only job is "do we have a valid user or not".
----------------------------------------------------------------*/
function AuthScreen({ onAuthenticated }) {
  const { t } = useLang();
  const [mode, setMode] = useState("login"); // "login" | "register"
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const path = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const body = mode === "login" ? { email, password } : { orgName, name, email, password };
      const data = await apiFetch(path, { method: "POST", body });
      setToken(data.token);
      onAuthenticated(data.user);
    } catch (e2) {
      setError(e2.message || t("auth.error.generic"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full min-h-screen flex items-center justify-center p-6 relative" style={{ background: C.greyBg }}>
      <style>{fontImport}</style>
      <div className="absolute top-6 right-6"><ThemeSwitch /></div>
      <div className="w-full max-w-sm rounded-3xl overflow-hidden" style={{ background: C.surface, border: `1px solid ${C.greyBorder}` }}>
        <div className="px-8 pt-8 pb-6" style={{ background: C.navyDeep }}>
          <div className="flex items-center gap-2 mb-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: C.blue }}><Zap size={15} color="white" /></div>
            <span className="text-white font-semibold text-[15px]">{t("auth.brand")}</span>
          </div>
          <h2 className="mt-3 text-xl font-semibold text-white">{mode === "login" ? t("auth.login.title") : t("auth.register.title")}</h2>
          <p className="mt-1 text-sm" style={{ color: "#B7C4DA" }}>{mode === "login" ? t("auth.login.subtitle") : t("auth.register.subtitle")}</p>
        </div>
        <form onSubmit={submit} className="p-6 space-y-3">
          {mode === "register" && (
            <>
              <input required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder={t("auth.orgName")}
                className="w-full text-sm px-3 py-2.5 rounded-xl outline-none" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }} />
              <input required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auth.name")}
                className="w-full text-sm px-3 py-2.5 rounded-xl outline-none" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }} />
            </>
          )}
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("auth.email")}
            className="w-full text-sm px-3 py-2.5 rounded-xl outline-none" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }} />
          <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t("auth.password")}
            className="w-full text-sm px-3 py-2.5 rounded-xl outline-none" style={{ border: `1px solid ${C.greyBorder}`, color: C.charcoal }} />
          {error && <div className="px-3 py-2 rounded-lg text-sm" style={{ background: C.redSoft, color: C.red }}>{error}</div>}
          <button type="submit" disabled={loading} className="w-full py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-50 flex items-center justify-center gap-2" style={{ background: C.blue }}>
            {loading ? <><Loader2 size={14} className="animate-spin" /> {t("auth.loading")}</> : (mode === "login" ? t("auth.login.cta") : t("auth.register.cta"))}
          </button>
          <button type="button" onClick={() => { setError(""); setMode((m) => (m === "login" ? "register" : "login")); }} className="w-full text-sm text-center" style={{ color: C.blue }}>
            {mode === "login" ? t("auth.switchToRegister") : t("auth.switchToLogin")}
          </button>
        </form>
      </div>
    </div>
  );
}


export default AuthScreen;
