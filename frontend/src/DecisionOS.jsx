import React from "react";
import { fontImport, ThemeModeProvider } from "./lib/theme";
import { LangProvider } from "./lib/i18n";
import { ToastProvider } from "./components/ui";
import AuthGate from "./auth/AuthGate";

// Thin entry point. Everything else now lives under app/, pages/,
// components/, lib/, api/ and auth/ (see FASE 6 restructuring).
export default function DecisionOS() {
  return (
    <ThemeModeProvider>
      <LangProvider>
        <style>{fontImport}</style>
        <ToastProvider>
          <AuthGate />
        </ToastProvider>
      </LangProvider>
    </ThemeModeProvider>
  );
}
