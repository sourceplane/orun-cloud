// AN4 (saas-agents-native): chat-worker routes — deny-by-default authz, the
// create → list → turn flow over mock DO namespaces, the owner-bearer
// requirement on the turn route, and the one-voice 409.

import { route, type ChatDeps, type WorkspaceAgentRpc, type ChatIndexRpc } from "@chat-worker/router";
import type { Env } from "@chat-worker/env";
import type { ChatMeta } from "@chat-worker/chat-thread";
import type { ChatSummary } from "@chat-worker/chat-index";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";

function makeDeps(allowed = true): ChatDeps {
  let n = 0;
  return {
    async authorize() {
      return allowed;
    },
    now: () => new Date("2026-07-17T12:00:00Z"),
    newChatId: () => `ch_test${++n}`,
  };
}

interface FakeAgents {
  ns: NonNullable<Env["WORKSPACE_AGENT"]>;
  turns: { orgId: string; text: string; principal: string; token: string }[];
  metas: Map<string, ChatMeta>;
}

function fakeAgentNs(turnResult: { ok: boolean; reason?: string } = { ok: true }): FakeAgents {
  const metas = new Map<string, ChatMeta>();
  const turns: FakeAgents["turns"] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) =>
      ({
        async initChat(meta: ChatMeta) {
          metas.set(id.name, meta);
        },
        async chatInfo() {
          return metas.get(id.name) ?? null;
        },
        async history() {
          return [];
        },
        async turn(orgId: string, text: string, principal: string, token: string) {
          turns.push({ orgId, text, principal, token });
          return turnResult;
        },
      }) satisfies WorkspaceAgentRpc,
  } as unknown as NonNullable<Env["WORKSPACE_AGENT"]>;
  return { ns, turns, metas };
}

function fakeIndexNs(): { ns: NonNullable<Env["CHAT_INDEX"]>; chats: ChatSummary[] } {
  const chats: ChatSummary[] = [];
  const ns = {
    idFromName: (name: string) => ({ name }),
    get: () =>
      ({
        async register(c: ChatSummary) {
          chats.push(c);
        },
        async touch(id: string, lastAt: string) {
          const c = chats.find((x) => x.id === id);
          if (c) c.lastAt = lastAt;
        },
        async listChats() {
          return [...chats];
        },
      }) satisfies ChatIndexRpc,
  } as unknown as NonNullable<Env["CHAT_INDEX"]>;
  return { ns, chats };
}

function req(path: string, opts?: { method?: string; body?: unknown; headers?: Record<string, string> }): Request {
  return new Request(`https://chat-worker${path}`, {
    method: opts?.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
      ...(opts?.headers ?? {}),
    },
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

describe("AN4: chat routes", () => {
  const base = `/v1/organizations/${ORG}/agents/chats`;

  it("denies by default: unauthorized actors get 403 on every chat route", async () => {
    const env = { ENVIRONMENT: "test", WORKSPACE_AGENT: fakeAgentNs().ns, CHAT_INDEX: fakeIndexNs().ns } as Env;
    const deps = makeDeps(false);
    for (const [method, path, body] of [
      ["GET", base, undefined],
      ["POST", base, {}],
      ["GET", `${base}/ch_1`, undefined],
      ["POST", `${base}/ch_1/turn`, { text: "hi" }],
    ] as const) {
      const res = await route(req(path, { method, body }), env, deps);
      expect(res.status).toBe(403);
    }
  });

  it("creates a thread (workspace-bound), lists it, serves its history", async () => {
    const agents = fakeAgentNs();
    const index = fakeIndexNs();
    const env = { ENVIRONMENT: "test", WORKSPACE_AGENT: agents.ns, CHAT_INDEX: index.ns } as Env;
    const deps = makeDeps();

    const created = await route(req(base, { method: "POST", body: { title: "Ship ORN-142" } }), env, deps);
    expect(created.status).toBe(201);
    const chat = ((await created.json()) as { data: { id: string; title: string } }).data;
    expect(chat.title).toBe("Ship ORN-142");
    expect(agents.metas.get(`chat:${chat.id}`)?.orgId).toBe(ORG_UUID);

    const list = await route(req(base), env, deps);
    expect(((await list.json()) as { data: ChatSummary[] }).data.map((c) => c.id)).toEqual([chat.id]);

    const detail = await route(req(`${base}/${chat.id}`), env, deps);
    expect(detail.status).toBe(200);
    expect(((await detail.json()) as { data: { id: string } }).data.id).toBe(chat.id);
  });

  it("a turn requires the owner bearer and carries it + the principal to the DO", async () => {
    const agents = fakeAgentNs();
    const index = fakeIndexNs();
    const env = { ENVIRONMENT: "test", WORKSPACE_AGENT: agents.ns, CHAT_INDEX: index.ns } as Env;
    const deps = makeDeps();

    const noBearer = await route(req(`${base}/ch_1/turn`, { method: "POST", body: { text: "hi" } }), env, deps);
    expect(noBearer.status).toBe(403);

    const ok = await route(
      req(`${base}/ch_1/turn`, { method: "POST", body: { text: "hi" }, headers: { "x-owner-bearer": "tok-owner" } }),
      env,
      deps,
    );
    expect(ok.status).toBe(202);
    expect(agents.turns).toEqual([{ orgId: ORG_UUID, text: "hi", principal: "usr_rahul", token: "tok-owner" }]);
  });

  it("maps turn_in_progress to a 409 (one voice per thread)", async () => {
    const agents = fakeAgentNs({ ok: false, reason: "turn_in_progress" });
    const env = { ENVIRONMENT: "test", WORKSPACE_AGENT: agents.ns, CHAT_INDEX: fakeIndexNs().ns } as Env;
    const res = await route(
      req(`${base}/ch_1/turn`, { method: "POST", body: { text: "hi" }, headers: { "x-owner-bearer": "t" } }),
      env,
      makeDeps(),
    );
    expect(res.status).toBe(409);
  });

  it("503s when the DO namespaces are unbound (dormant posture)", async () => {
    const env = { ENVIRONMENT: "test" } as Env;
    const res = await route(req(base), env, makeDeps());
    expect(res.status).toBe(503);
  });
});
