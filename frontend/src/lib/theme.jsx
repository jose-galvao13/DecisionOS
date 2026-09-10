import React, { createContext, useContext, useEffect, useState } from "react";

/* ---------------------------------------------------------------
   DESIGN TOKENS

   Each token used to be a literal hex string. It's now a CSS custom
   property reference (`var(--blue)`, etc.) — every one of the ~500
   existing `C.x` usages across the app keeps working unchanged,
   including the ones captured in module-level constant objects
   (STATUS_META, TONE_META, ...) that are only evaluated once at
   import time, *because* a `var(--x)` string is just a string until
   the browser paints it — the actual color is resolved live from
   whatever `[data-theme]` is on <html> at that moment. That's what
   makes dark mode a CSS flip instead of a rewrite of every page.

   Two roles that both used to be `white` had to be split apart,
   because they need to do opposite things in dark mode:
   - `C.surface`: the background of cards/headers/panels — this is
     what should turn dark.
   - `C.white`: literal white, used as *text* on an already-dark or
     already-colored background (e.g. white text on a blue button) —
     this must stay white in both themes, or that text disappears.
----------------------------------------------------------------*/
const C = {
  navyDeep: "var(--navy-deep)", navy: "var(--navy)", navySoft: "var(--navy-soft)",
  blueDark: "var(--blue-dark)", blue: "var(--blue)", blueSoft: "var(--blue-soft)",
  white: "var(--white)", surface: "var(--surface)",
  greyBg: "var(--grey-bg)", greyBorder: "var(--grey-border)",
  greyBorderSoft: "var(--grey-border-soft)", charcoal: "var(--charcoal)",
  textSecondary: "var(--text-secondary)", textMuted: "var(--text-muted)",
  green: "var(--green)", greenSoft: "var(--green-soft)",
  red: "var(--red)", redSoft: "var(--red-soft)",
  yellow: "var(--yellow)", yellowSoft: "var(--yellow-soft)",
};

/** Alpha-blended "soft badge" backgrounds (e.g. a status pill using
 *  ~15% of its own text color as a background) used to be built as
 *  `${hexColor}22` string concatenation. That only works when the
 *  color is a literal hex string — it silently produces garbage CSS
 *  once the color is `var(--x)`. color-mix() is the CSS-native
 *  replacement and works the same in both themes since it resolves
 *  the custom property first. Supported in all current evergreen
 *  browsers (Chrome/Edge 111+, Firefox 113+, Safari 16.4+), which
 *  covers both the webview DecisionOS Desktop embeds and any
 *  reasonably current browser this runs in. */
function tint(color, pct = 15) {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/* ---------------------------------------------------------------
   THEME VARIABLES + base styles. Rendered via <style>{fontImport}</style>
   at the three app shells (DecisionOS.jsx, AuthScreen.jsx,
   DecisionOSApp.jsx) — kept in the same exported string so none of
   those three needed to change to pick this up.

   Deliberately NOT re-themed for dark mode (documented, not hidden):
   - box-shadow colors are hardcoded rgba(10,21,38,x) throughout the
     app. They're dark shadows, so they still read as "shadow" on a
     dark surface too, just less visible — a real but minor cosmetic
     gap, not a broken/unreadable one.
   - chart color arrays in BusinessIntelligence.jsx / Overview.jsx
     (recharts series colors) are a separate hardcoded palette, not
     wired to these tokens. They stay legible in dark mode (they're
     saturated colors against the surface), just not palette-matched.
----------------------------------------------------------------*/
const fontImport = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  * { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; }
  .tabnum { font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }

  :root {
    --navy-deep: #0A1526; --navy: #0E1E36; --navy-soft: #132846;
    --blue-dark: #173B6E; --blue: #2E6FEA; --blue-soft: #EAF1FE;
    --white: #FFFFFF; --surface: #FFFFFF;
    --grey-bg: #F4F6FA; --grey-border: #E3E7EE; --grey-border-soft: #EDF0F5;
    --charcoal: #1B2431;
    --text-secondary: #5C6673; --text-muted: #8891A0;
    --green: #157A4F; --green-soft: #E7F5EE;
    --red: #B3382A; --red-soft: #FBEAE7;
    --yellow: #A8690A; --yellow-soft: #FCF1E1;
  }
  /* The sidebar's navy tones are intentionally identical in both
     themes (it's already a dark rail in light mode) — only surfaces,
     borders, body text and "soft" badge backgrounds actually flip. */
  [data-theme="dark"] {
    --surface: #121A2C;
    --grey-bg: #0A0F1C; --grey-border: #232E47; --grey-border-soft: #1A2338;
    --charcoal: #E8ECF4;
    --text-secondary: #A7B1C4; --text-muted: #6E7893;
    --blue-soft: #15233F; --green-soft: #11291F; --red-soft: #2E1917; --yellow-soft: #2F250F;
  }
  html, body { background: var(--grey-bg); }
  body, body * { transition: background-color .12s ease, border-color .12s ease, color .12s ease; }
`;

/* ---------------------------------------------------------------
   THEME MODE — light/dark toggle. Persisted to localStorage (this is
   a real desktop/web product, not a Claude.ai artifact, so
   localStorage is the right tool here) and defaults to the OS-level
   preference the first time someone opens the app. index.html also
   sets the attribute synchronously before React mounts, so there's
   no flash of the wrong theme on load — this effect just keeps
   later toggles and the OS-preference listener in sync.
----------------------------------------------------------------*/
const THEME_STORAGE_KEY = "decisionos-theme";
const ThemeModeContext = createContext({ mode: "light", toggle: () => {}, setMode: () => {} });

function getInitialMode() {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function ThemeModeProvider({ children }) {
  const [mode, setModeState] = useState(getInitialMode);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", mode);
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  }, [mode]);

  // Follow the OS setting live, but only until the person makes an
  // explicit choice of their own (tracked via the "-explicit" key
  // written the first time setMode()/toggle() runs).
  useEffect(() => {
    if (window.localStorage.getItem(THEME_STORAGE_KEY + "-explicit") === "1") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => setModeState(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setMode = (next) => {
    window.localStorage.setItem(THEME_STORAGE_KEY + "-explicit", "1");
    setModeState(next);
  };
  const toggle = () => setMode(mode === "dark" ? "light" : "dark");

  return <ThemeModeContext.Provider value={{ mode, toggle, setMode }}>{children}</ThemeModeContext.Provider>;
}

function useThemeMode() {
  return useContext(ThemeModeContext);
}

export { C, fontImport, tint, ThemeModeProvider, useThemeMode };
