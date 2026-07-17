// AN5 (saas-agents-native): the hands. The verbs re-enter public surfaces
// with the owner's credential; a dispatch refusal renders its reason
// in-thread; steer/interrupt carry the workspace-agent disclosure; watch
// folds pending approvals as human-only cards. Lock 5 is pinned
// STRUCTURALLY: no verdict verb exists, and no frame this module can emit
// is a verdict.

import {
  executeSessionVerb,
  sessionVerbSpecs,
  isSessionVerb,
  withSessionVerbs,
  type SessionVerbDeps,
  type VerbHttp,
} from "@chat-worker/session-verbs";
import type { ToolExecutor } from "@chat-worker/chat-thread";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeHttp(routes: Record<string, (call: Call) => Response>): { http: VerbHttp; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    http: {
      async fetch(input, init) {
        const call: Call = {
          url: input,
          method: init?.method ?? "GET",
          headers: (init?.headers as Record<string, string>) ?? {},
          ...(init?.body ? { body: JSON.parse(init.body) } : {}),
        };
        calls.push(call);
        const path = new URL(input).pathname;
        const handler = Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1];
        return handler ? handler(call) : new Response("not found", { status: 404 });
      },
    },
  };
}

function deps(http: VerbHttp): SessionVerbDeps {
  let n = 0;
  return { baseUrl: "https://api.test", ownerToken: "tok-owner", http, orgPublicId: "org_abc", newRef: () => `wa-${++n}` };
}

describe("AN5: lock 5 is structural — no verdict is expressible", () => {
  it("exposes exactly four verbs, none verdict-shaped", () => {
    const names = sessionVerbSpecs().map((s) => s.name);
    expect(names.sort()).toEqual(["session_interrupt", "session_spawn", "session_steer", "session_watch"]);
    for (const spec of sessionVerbSpecs()) {
      expect(spec.name).not.toMatch(/verdict|approv|deny/);
      expect(JSON.stringify(spec.inputSchema)).not.toMatch(/approved|verdict/);
    }
  });

  it("the input door emits only steer/interrupt frames — never a verdict", async () => {
    const { http, calls } = fakeHttp({
      "/input": () => Response.json({ ok: true }),
    });
    const d = deps(http);
    await executeSessionVerb("session_steer", { sessionId: "as_1", text: "go" }, d);
    await executeSessionVerb("session_interrupt", { sessionId: "as_1" }, d);
    const frames = calls.map((c) => c.body as { t: string });
    expect(frames.map((f) => f.t)).toEqual(["steer", "interrupt"]);
    for (const f of frames) {
      expect(JSON.stringify(f)).not.toContain("verdict");
      expect(JSON.stringify(f)).not.toContain("approved");
    }
  });
});

describe("AN5: the verbs through the public doors", () => {
  it("spawn walks the dispatch door with the owner bearer and reports the session", async () => {
    const { http, calls } = fakeHttp({
      "/dispatch": () => Response.json({ data: { id: "as_new1", state: "requested" } }),
    });
    const r = await executeSessionVerb("session_spawn", { taskKey: "ORN-142" }, deps(http));
    expect(r.isError).toBeUndefined();
    expect(r.summary).toContain("as_new1");
    expect(calls[0]!.url).toBe("https://api.test/v1/organizations/org_abc/agents/dispatch");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok-owner");
    expect(calls[0]!.body).toEqual({ taskKey: "ORN-142" });
  });

  it("a refused spawn surfaces the door's reason verbatim (budget/gate refusals render in-thread)", async () => {
    const { http } = fakeHttp({
      "/dispatch": () =>
        Response.json(
          { error: { code: "budget_exhausted", message: "workspace ceiling 1000000 tokens reached" } },
          { status: 409 },
        ),
    });
    const r = await executeSessionVerb("session_spawn", { taskKey: "ORN-142" }, deps(http));
    expect(r.isError).toBe(true);
    expect(r.summary).toContain("workspace ceiling 1000000 tokens reached");
    expect((r.data as { refused: boolean }).refused).toBe(true);
  });

  it("steer carries the workspace-agent disclosure in the frame payload", async () => {
    const { http, calls } = fakeHttp({ "/input": () => Response.json({ ok: true }) });
    const r = await executeSessionVerb("session_steer", { sessionId: "as_7", text: "also update the changelog" }, deps(http));
    expect(r.isError).toBeUndefined();
    const frame = calls[0]!.body as { t: string; text: string; payload: Record<string, unknown>; ref: string };
    expect(frame.t).toBe("steer");
    expect(frame.text).toBe("also update the changelog");
    expect(frame.payload.via).toBe("workspace-agent");
    expect(frame.ref).toBe("wa-1");
  });

  it("an unacked steer is an honest error result", async () => {
    const { http } = fakeHttp({ "/input": () => Response.json({ ok: false, reason: "no_consumer" }) });
    const r = await executeSessionVerb("session_steer", { sessionId: "as_7", text: "x" }, deps(http));
    expect(r.isError).toBe(true);
    expect(r.summary).toContain("no_consumer");
  });

  it("watch folds state, recent events, and PENDING approvals (resolved ones drop out)", async () => {
    const { http } = fakeHttp({
      "/events": () =>
        Response.json({
          data: [
            { seq: 0, kind: "state_changed", payload: { state: "running" } },
            { seq: 1, kind: "approval_requested", payload: { requestId: "req-1", tool: "contract_propose" } },
            { seq: 2, kind: "approval_resolved", payload: { requestId: "req-1" } },
            { seq: 3, kind: "approval_requested", payload: { requestId: "req-2", tool: "flag_set" } },
          ],
        }),
      "/sessions/as_9": () => Response.json({ data: { id: "as_9", state: "awaiting_approval" } }),
    });
    const r = await executeSessionVerb("session_watch", { sessionId: "as_9" }, deps(http));
    expect(r.isError).toBeUndefined();
    expect(r.summary).toContain("awaiting_approval");
    expect(r.summary).toContain("WAITING ON A HUMAN");
    const data = r.data as { pendingApprovals: { requestId: string }[]; recent: unknown[] };
    expect(data.pendingApprovals.map((a) => a.requestId)).toEqual(["req-2"]);
    expect(data.recent).toHaveLength(4);
  });

  it("merges into the base executor without shadowing platform tools", async () => {
    const base: ToolExecutor = {
      specs: () => [{ name: "runs_list", description: "d", inputSchema: {} }],
      execute: async () => ({ summary: "base", data: {} }),
    };
    const { http } = fakeHttp({});
    const merged = withSessionVerbs(base, deps(http));
    expect(merged.specs().map((s) => s.name)).toEqual([
      "runs_list",
      "session_spawn",
      "session_steer",
      "session_interrupt",
      "session_watch",
    ]);
    expect((await merged.execute("runs_list", {})).summary).toBe("base");
    expect(isSessionVerb("runs_list")).toBe(false);
    expect(isSessionVerb("session_spawn")).toBe(true);
  });
});
