import React, { useState, useRef, useEffect } from "react";
import {
  LayoutGrid, BarChart3, TrendingDown, LineChart as LineChartIcon,
  SlidersHorizontal, Sparkles, Database, FileSpreadsheet, Settings,
  X, Send, MessageSquare, Loader2, Users,
} from "lucide-react";
import { C } from "../lib/theme";
import { useLang } from "../lib/i18n";
import { callClaudeWithTools, CHAT_SYSTEM } from "../api/aiClient";
import { buildDigest } from "../lib/digest";

/* ---------------------------------------------------------------
   CHAT WIDGET — AI calls via the backend, grounded in the analytics tools
----------------------------------------------------------------*/
function ChatWidget({ analytics, filters, sourceInfo }) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([{ role: "ai", text: t("chat.greeting") }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setMessages((m) => (m.length === 1 && m[0].role === "ai" ? [{ role: "ai", text: t("chat.greeting") }] : m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  const send = async () => {
    if (!input.trim() || loading) return;
    const q = input;
    setMessages((m) => [...m, { role: "user", text: q }]);
    setInput(""); setLoading(true);
    if (sourceInfo?.type === "demo") {
      setMessages((m) => [...m, { role: "ai", text: t("chat.needsRealData") }]);
      setLoading(false);
      return;
    }
    try {
      // CHAT_SYSTEM tells the model to call the analytics tools, so use the
      // server-side tool loop (same as the Advisor). The active filters go
      // after the question, as the prompt expects.
      const scope = buildDigest(analytics, filters).activeFilters;
      const answer = await callClaudeWithTools(CHAT_SYSTEM[lang], `Question: ${q}\n\nActive filters: ${JSON.stringify(scope)}`, { filters, maxRounds: 3 });
      setMessages((m) => [...m, { role: "ai", text: answer }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "ai", text: t("chat.error") }]);
    } finally { setLoading(false); }
  };

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 z-40 w-96 rounded-2xl overflow-hidden flex flex-col" style={{ background: C.surface, border: `1px solid ${C.greyBorder}`, boxShadow: "0 20px 40px rgba(10,21,38,0.18)", maxHeight: 480 }}>
          <div className="px-4 py-3 flex items-center justify-between" style={{ background: C.navyDeep }}>
            <div className="flex items-center gap-2 text-white text-sm font-medium"><Sparkles size={15} /> {t("chat.title")}</div>
            <button onClick={() => setOpen(false)}><X size={16} color="#B7C4DA" /></button>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.map((m, i) => (
              <div key={i} className={`max-w-[85%] text-sm p-3 rounded-xl ${m.role === "user" ? "ml-auto" : ""}`} style={m.role === "user" ? { background: C.blue, color: C.white } : { background: C.greyBg, color: C.charcoal }}>{m.text}</div>
            ))}
            {loading && <div className="max-w-[85%] text-sm p-3 rounded-xl flex items-center gap-2" style={{ background: C.greyBg, color: C.textMuted }}><Loader2 size={13} className="animate-spin" /> {t("chat.thinking")}</div>}
          </div>
          <div className="p-3 flex items-center gap-2" style={{ borderTop: `1px solid ${C.greyBorder}` }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder={t("chat.placeholder")} className="flex-1 text-sm outline-none px-3 py-2 rounded-lg" style={{ background: C.greyBg, color: C.charcoal }} />
            <button onClick={send} className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: C.blue }}><Send size={15} color="white" /></button>
          </div>
        </div>
      )}
      <button onClick={() => setOpen((o) => !o)} className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full flex items-center justify-center" style={{ background: C.blue, boxShadow: "0 10px 24px rgba(46,111,234,0.4)" }}>
        <MessageSquare size={22} color="white" />
      </button>
    </>
  );
}

export default ChatWidget;
