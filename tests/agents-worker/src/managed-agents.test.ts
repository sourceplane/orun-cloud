// The anthropic-managed executor (saas-dispatch DX7). Invariants under test:
// the adapter's spawn is agent → session → first user.message (nothing runs
// until the event); failures redact to status codes (never a provider body);
// the event translation lands ONLY in the closed session-event vocabulary
// (no status kind exists to land in); unknown managed kinds drop.

import {
  createManagedAgentsAdapter,
  translateManagedEvent,
  ManagedAgentsError,
} from "@agents-worker/providers/managed-agents";
import { SESSION_EVENT_KINDS } from "@saas/db/agents";

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function fakeFetch(
  responses: Array<{ status: number; body?: unknown }>,
): { fn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : "provider says: secret account detail", {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fn, calls };
}

const SPEC = {
  model: "claude-opus-4-8",
  system: "you are a governed run",
  tools: ["catalog", "work"],
  brief: "Run kind: interactive. Target: task ORN-9.",
  title: "ORN-9",
};

describe("ManagedAgentsAdapter.spawn (DX7)", () => {
  it("creates agent → session → first user.message, beta-headered, tools narrowed at definition time", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { id: "ma_agent1" } },
      { status: 200, body: { id: "ma_sess1" } },
      { status: 200, body: { ok: true } },
    ]);
    const adapter = createManagedAgentsAdapter({ apiKey: "sk-ant-x", fetchFn: fn });
    const ref = await adapter.spawn(SPEC);

    expect(ref).toEqual({ provider: "anthropic-managed", agentId: "ma_agent1", sessionId: "ma_sess1" });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toContain("/v1/agents");
    expect(calls[0]!.headers["anthropic-beta"]).toBe("managed-agents-2026-04-01");
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-ant-x");
    // Definition-time narrowing: exactly the allowlist, as MCP toolsets.
    expect(calls[0]!.body.tools).toEqual([
      { type: "mcp_toolset", mcp_server_name: "catalog" },
      { type: "mcp_toolset", mcp_server_name: "work" },
    ]);
    expect(calls[1]!.url).toContain("/v1/sessions");
    expect(calls[1]!.body.agent).toBe("ma_agent1");
    // Nothing runs until the first event: the brief is the user.message.
    expect(calls[2]!.url).toContain("/v1/sessions/ma_sess1/events");
    const events = calls[2]!.body.events as Array<{ type: string; content: Array<{ text: string }> }>;
    expect(events[0]!.type).toBe("user.message");
    expect(events[0]!.content[0]!.text).toContain("ORN-9");
  });

  it("redacts provider failures to a status code — never the body", async () => {
    const { fn } = fakeFetch([{ status: 402 }]);
    const adapter = createManagedAgentsAdapter({ apiKey: "sk-ant-x", fetchFn: fn });
    const err = await adapter.spawn(SPEC).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagedAgentsError);
    expect((err as ManagedAgentsError).step).toBe("agent.create");
    expect((err as ManagedAgentsError).message).toBe("402 from provider");
    expect(String(err)).not.toContain("secret account detail");
  });

  it("honors a config baseUrl override (gateway posture)", async () => {
    const { fn, calls } = fakeFetch([
      { status: 200, body: { id: "a" } },
      { status: 200, body: { id: "s" } },
      { status: 200, body: {} },
    ]);
    const adapter = createManagedAgentsAdapter({ apiKey: "k", apiUrl: "https://gw.example/anthropic/", fetchFn: fn });
    await adapter.spawn(SPEC);
    expect(calls[0]!.url).toBe("https://gw.example/anthropic/v1/agents");
  });
});

describe("event translation (design §10.2)", () => {
  it("maps managed events into the closed vocabulary only", () => {
    const cases: Array<[string, string]> = [
      ["agent.message", "message_agent"],
      ["user.message", "message_user"],
      ["agent.tool_use", "tool_call"],
      ["agent.tool_result", "tool_result"],
      ["session.status_idle", "state_changed"],
      ["session.error", "error"],
    ];
    for (const [managed, expected] of cases) {
      const out = translateManagedEvent({ type: managed })!;
      expect(out.kind).toBe(expected);
      expect((SESSION_EVENT_KINDS as readonly string[]).includes(out.kind)).toBe(true);
      expect(out.payload.via).toBe("anthropic-managed");
    }
  });

  it("drops unknown managed kinds — the closed vocabulary never widens silently", () => {
    expect(translateManagedEvent({ type: "session.billing_hint" })).toBeNull();
    expect(translateManagedEvent({})).toBeNull();
  });

  it("carries the tool name on tool_call, and idle maps to a state signal — never a status assertion", () => {
    expect(translateManagedEvent({ type: "agent.tool_use", name: "bash" })!.payload.tool).toBe("bash");
    const idle = translateManagedEvent({ type: "session.status_idle" })!;
    expect(idle.kind).toBe("state_changed");
    expect(idle.payload.signal).toBe("idle");
  });
});
