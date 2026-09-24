import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatCompletion, toOpenAITools, parseToolArgs, isLlmConfigured, LlmError } from "../../src/llm.js";
import { AI_TOOLS_SCHEMA } from "../../src/analytics-tools.js";

const ok = (message) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message }] }) });
const fail = (status, text, headers = {}) => ({ ok: false, status, text: async () => text, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

describe("llm client", () => {
  beforeEach(() => {
    process.env.LLM_API_KEY = "test-key";
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.LLM_API_KEY;
  });

  it("converts every Anthropic-style tool to the OpenAI function format", () => {
    const out = toOpenAITools(AI_TOOLS_SCHEMA);
    expect(out).toHaveLength(AI_TOOLS_SCHEMA.length);
    expect(out[0]).toMatchObject({ type: "function", function: { name: AI_TOOLS_SCHEMA[0].name, parameters: { type: "object" } } });
  });

  it("parses tool arguments defensively", () => {
    expect(parseToolArgs("")).toEqual({});
    expect(parseToolArgs("null")).toEqual({});
    expect(parseToolArgs("not json")).toEqual({});
    expect(parseToolArgs('{"percentChange":"5"}')).toEqual({ percentChange: 5 });
    expect(parseToolArgs('{"ticker":"AAPL","percent":25}')).toEqual({ ticker: "AAPL", percent: 25 });
  });

  it("reports whether a key is configured", () => {
    expect(isLlmConfigured()).toBe(true);
    delete process.env.LLM_API_KEY;
    delete process.env.GROQ_API_KEY;
    expect(isLlmConfigured()).toBe(false);
  });

  it("calls the Groq endpoint by default with a Bearer key and the system prompt first", async () => {
    const f = vi.fn().mockResolvedValue(ok({ role: "assistant", content: "olá" }));
    vi.stubGlobal("fetch", f);
    const msg = await chatCompletion({ system: "SYS", messages: [{ role: "user", content: "hi" }], tools: AI_TOOLS_SCHEMA });
    expect(msg.content).toBe("olá");
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.messages[0]).toEqual({ role: "system", content: "SYS" });
    expect(body.tools.length).toBe(AI_TOOLS_SCHEMA.length);
  });

  it("retries once when Llama produces a malformed tool call", async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(400, '{"error":{"code":"tool_use_failed"}}')).mockResolvedValueOnce(ok({ role: "assistant", content: "ok" }));
    vi.stubGlobal("fetch", f);
    const msg = await chatCompletion({ system: "S", messages: [] });
    expect(msg.content).toBe("ok");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("surfaces rate limits as LlmError with status 429", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fail(429, "too many", { "retry-after": "60" })));
    await expect(chatCompletion({ system: "S", messages: [] })).rejects.toMatchObject({ name: "LlmError", status: 429 });
  });
});
