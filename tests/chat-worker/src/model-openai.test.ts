// The OpenAI-compatible ModelClient (saas-dispatch DX-Q6): message
// translation from the loop's Anthropic-native shapes, SSE streaming with
// live deltas, tool-call accumulation across chunks, usage, and the
// modelClientFor factory's provider routing.

import { modelClientFor, openaiCompatibleModel, toOpenAIMessages } from "@chat-worker/model";
import type { ModelRequestMessage } from "@chat-worker/chat-thread";

function sse(...chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(new TextEncoder().encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("toOpenAIMessages", () => {
  it("prepends system and passes plain string turns through", () => {
    const msgs: ModelRequestMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(toOpenAIMessages("SYS", msgs)).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("translates an assistant tool_use round + tool_result round to OpenAI shape", () => {
    const msgs: ModelRequestMessage[] = [
      { role: "user", content: "list work" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", id: "call_1", name: "work_query", input: { filter: "ready" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "{\"tasks\":[]}" }] },
    ];
    const out = toOpenAIMessages("SYS", msgs) as any[];
    expect(out[2]).toEqual({
      role: "assistant",
      content: "checking",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "work_query", arguments: JSON.stringify({ filter: "ready" }) } }],
    });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "{\"tasks\":[]}" });
  });
});

describe("openaiCompatibleModel.stream", () => {
  it("streams text deltas, hits the right endpoint with the model + bearer, and reports usage", async () => {
    let captured: { url: string; body: any; auth: string | null } | null = null;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      captured = {
        url: String(url),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("authorization"),
      };
      return sse(
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
      );
    }) as unknown as typeof fetch;

    const client = openaiCompatibleModel("sk-or-x", { baseUrl: "https://openrouter.ai/api/v1/", model: "anthropic/claude-sonnet-4", fetchFn });
    const deltas: string[] = [];
    const res = await client.stream({ system: "SYS", messages: [{ role: "user", content: "hi" }], tools: [] }, (d) => deltas.push(d));

    expect(captured!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured!.body.model).toBe("anthropic/claude-sonnet-4");
    expect(captured!.body.stream).toBe(true);
    expect(captured!.auth).toBe("Bearer sk-or-x");
    expect(deltas.join("")).toBe("Hello");
    expect(res.blocks).toEqual([{ type: "text", text: "Hello" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(res.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
  });

  it("accumulates a tool call across chunks and maps finish_reason=tool_calls", async () => {
    const fetchFn = (async () =>
      sse(
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "work_query" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"fil" } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "ter\":\"ready\"}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      )) as unknown as typeof fetch;

    const client = openaiCompatibleModel("k", { baseUrl: "https://api.openai.com/v1", model: "gpt-4o", fetchFn });
    const res = await client.stream({ system: "S", messages: [{ role: "user", content: "x" }], tools: [] }, () => {});
    expect(res.stopReason).toBe("tool_use");
    expect(res.blocks).toEqual([{ type: "tool_use", id: "call_9", name: "work_query", input: { filter: "ready" } }]);
  });

  it("throws a redacted status on a non-ok provider response", async () => {
    const fetchFn = (async () => new Response("provider account detail", { status: 402 })) as unknown as typeof fetch;
    const client = openaiCompatibleModel("k", { baseUrl: "https://api.openai.com/v1", model: "gpt-4o", fetchFn });
    await expect(
      client.stream({ system: "S", messages: [{ role: "user", content: "x" }], tools: [] }, () => {}),
    ).rejects.toThrow("402 from model provider");
  });
});

describe("modelClientFor", () => {
  it("routes providers and requires a model id for OpenAI-compatible", () => {
    expect(modelClientFor("anthropic", "sk-ant", {})).not.toBeNull();
    expect(modelClientFor("openrouter", "sk-or", { defaultModel: "anthropic/claude-sonnet-4" })).not.toBeNull();
    expect(modelClientFor("openai", "sk", { defaultModel: "gpt-4o" })).not.toBeNull();
    // OpenAI-compatible with no model id → null (honest; the connection needs one).
    expect(modelClientFor("openrouter", "sk-or", {})).toBeNull();
    expect(modelClientFor("daytona", "x", {})).toBeNull();
  });

  it("canonicalizes any openrouter.ai baseUrl to /api/v1 — the Anthropic skin (/api) is for sessions, not chat", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    for (const baseUrl of ["https://openrouter.ai/api", "https://openrouter.ai", "https://openrouter.ai/api/v1/"]) {
      const client = modelClientFor("openrouter", "sk-or", { defaultModel: "m", baseUrl }, fetchFn)!;
      await client.stream({ system: "S", messages: [{ role: "user", content: "x" }], tools: [] }, () => {}).catch(() => {});
    }
    expect(urls).toHaveLength(3);
    for (const u of urls) expect(u).toBe("https://openrouter.ai/api/v1/chat/completions");
    // A real custom gateway is honored verbatim.
    const custom = modelClientFor("openrouter", "sk-or", { defaultModel: "m", baseUrl: "https://gw.example/v1" }, fetchFn)!;
    await custom.stream({ system: "S", messages: [{ role: "user", content: "x" }], tools: [] }, () => {}).catch(() => {});
    expect(urls[3]).toBe("https://gw.example/v1/chat/completions");
  });
});
