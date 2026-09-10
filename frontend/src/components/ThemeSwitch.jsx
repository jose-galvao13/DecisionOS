import React from "react";
import { Sun, Moon } from "lucide-react";
import { C, useThemeMode } from "../lib/theme";

/* ---------------------------------------------------------------
   THEME SWITCH — light/dark pill toggle, same shape as LangSwitch so
   the two sit naturally side by side in the header.
----------------------------------------------------------------*/
function ThemeSwitch() {
  const { mode, setMode } = useThemeMode();
  return (
    <div className="flex items-center rounded-lg p-0.5" style={{ background: C.greyBg }}>
      {[
        { id: "light", Icon: Sun, label: "Light theme" },
        { id: "dark", Icon: Moon, label: "Dark theme" },
      ].map(({ id, Icon, label }) => (
        <button
          key={id}
          onClick={() => setMode(id)}
          title={label}
          aria-label={label}
          className="px-2 py-1 rounded-md transition-colors"
          style={mode === id ? { background: C.surface, color: C.charcoal, boxShadow: "0 1px 2px rgba(10,21,38,0.08)" } : { color: C.textMuted }}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}

export default ThemeSwitch;
