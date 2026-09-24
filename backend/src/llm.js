
const cfg = () => ({
  apiKey: process.env.LLM_API_KEY || process.env.GROQ_API_KEY || "",
  baseUrl: (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
  model: process.env.LLM_MODEL || "llama-3.3-70b-versatile",
});

export const isLlmConfigured = () => Boolean(cfg().apiKey);

export class LlmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "LlmError";
    this.status = status;
  }
}

export function toOpenAITools(schema) {
  return schema.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema || { type: "object", properties: {} } },
  }));
}

// Llama sometimes sends "", "null" or numbers as strings ("5") as tool arguments.
export function parseToolArgs(raw) {
  if (!raw) return {};
  let v;
  try {
    v = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  for (const k of ["percentChange", "percent"]) {
    if (typeof v[k] === "string" && v[k].trim() !== "" && Number.isFinite(Number(v[k]))) v[k] = Number(v[k]);
  }
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One chat-completions call. Returns the assistant `message` object
 *  ({ role, content, tool_calls? }). Retries once on malformed tool calls
 *  (a known Llama quirk) and once on a short rate-limit wait. */
export async function chatCompletion({ system, messages, tools, maxTokens = 1000 }) {
  const { apiKey, baseUrl, model } = cfg();
  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0.2,
    messages: [{ role: "system", content: system }, ...messages],
  };
  if (tools?.length) {
    body.tools = toOpenAITools(tools);
    body.tool_choice = "auto";
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new LlmError("LLM returned no message", 502);
      return msg;
    }
    const errText = await res.text().catch(() => "");
    const malformedToolCall = res.status === 400 && /tool_use_failed|failed to call a function/i.test(errText);
    if (malformedToolCall && attempt < 2) continue;
    if (res.status === 429 && attempt < 1) {
      const wait = Number(res.headers.get("retry-after"));
      if (Number.isFinite(wait) && wait > 0 && wait <= 8) {
        await sleep(wait * 1000);
        continue;
      }
    }
    throw new LlmError(`LLM API error ${res.status}: ${errText.slice(0, 500)}`, res.status);
  }
  throw new LlmError("LLM API: retries exhausted", 502);
}
