import React, { useState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { C } from "../lib/theme";
import { getToken, setToken, apiFetch } from "../api/client";
import AuthScreen from "./AuthScreen";
import DecisionOSApp from "../app/DecisionOSApp";

function AuthGate() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) { setChecking(false); return; }
      try {
        const data = await apiFetch("/api/auth/me");
        if (!cancelled) setUser(data.user);
      } catch {
        setToken(null);
      }
      if (!cancelled) setChecking(false);
    })();
    const onUnauthorized = () => setUser(null);
    window.addEventListener("decisionos:unauthorized", onUnauthorized);
    return () => { cancelled = true; window.removeEventListener("decisionos:unauthorized", onUnauthorized); };
  }, []);

  if (checking) {
    return (
      <div className="w-full min-h-screen flex items-center justify-center" style={{ background: C.greyBg }}>
        <Loader2 size={20} className="animate-spin" color={C.textMuted} />
      </div>
    );
  }
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  return <DecisionOSApp user={user} onLogout={() => { setToken(null); setUser(null); }} />;
}


export default AuthGate;
