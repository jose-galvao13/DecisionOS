import React from "react";
import { C } from "../lib/theme";
import { useLang } from "../lib/i18n";

/* ---------------------------------------------------------------
   LANGUAGE SWITCH — small pill toggle used in the header
----------------------------------------------------------------*/
function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <div className="flex items-center rounded-lg p-0.5 text-xs font-semibold" style={{ background: C.greyBg }}>
      {["pt", "en"].map((l) => (
        <button
          key={l}
          onClick={() => setLang(l)}
          className="px-2.5 py-1 rounded-md transition-colors"
          style={lang === l ? { background: C.surface, color: C.charcoal, boxShadow: "0 1px 2px rgba(10,21,38,0.08)" } : { color: C.textMuted }}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}


export default LangSwitch;
