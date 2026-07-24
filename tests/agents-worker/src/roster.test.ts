// The roster fold (saas-agent-supervision SV1, design §7.2): GET
// …/chats/:chatId/implementers returns exactly this thread's dispatch-origin
// sessions, split active/terminal, joined with the needs-you fold. Read-gated
// (a viewer without session.read gets 403); a spawn from the thread appears in
// the fold; the counts are the one truth the panel and roll-up both render.

import { route } from "@agents-worker/router";
import { foldChatImplementers } from "@agents-worker/handlers/roster";
import type { AgentsDeps } from "@agents-worker/deps";
import { MemoryAgentsRepository } from "@saas/db/agents";
import type { AgentOrigin } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";
import type { ChatImplementers } from "@saas/contracts/agents";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };

function makeDeps(overrides?: { repo?: MemoryAgentsRepository; grants?: string[] }): AgentsDeps {
  return {
    repo: overrides?.repo ?? new MemoryAgentsRepository(),
    async authorize(action) {
      return overrides?.grants ? overrides.grants.includes(action) : true;
    },
    async dispose() {},
  };
}

function req(method: string, path: string): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
    },
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string } };
}

async function seedProfile(repo: MemoryAgentsRepository, name = "impl-default") {
  return repo.createProfile(SCOPE, {
    name,
    principalId: "sp_agent1",
    owner: "team/platform",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
}

async function seed(repo: MemoryAgentsRepository, profileId: string, origin: AgentOrigin, to?: string) {
  const s = await repo.createSession(SCOPE, {
    profileId,
    runKind: "implementation",
    spawnedBy: "usr_rahul",
    origin,
  });
  if (to === "running") {
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "provisioning" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "running" });
  } else if (to === "completed") {
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "provisioning" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "running" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "completing" });
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "completed" });
  }
  return s;
}

const path = (chatId: string) => `/v1/organizations/${ORG}/agents/chats/${chatId}/implementers`;

describe("roster fold — GET …/chats/:chatId/implementers (SV1)", () => {
  it("returns exactly this thread's dispatch-origin sessions, active vs done", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo);
    // Two active for ch_1, one done for ch_1, plus noise: another thread + a
    // work-origin session that must NOT fold in.
    await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_1" }, "running");
    await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_1" });
    await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_1" }, "completed");
    await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_other" }, "running");
    await seed(repo, p.publicId, { kind: "work", ref: "ORN-9" }, "running");

    const res = await route(req("GET", path("ch_1")), env, makeDeps({ repo }));
    expect(res.status).toBe(200);
    const roster = (await json(res)).data as ChatImplementers;
    expect(roster.chatId).toBe("ch_1");
    expect(roster.active.length).toBe(2);
    expect(roster.running).toBe(1);
    expect(roster.done).toBe(1);
    expect(roster.needsYou).toBe(0);
    // Every active entry is a dispatch-origin session of THIS thread.
    for (const e of roster.active) {
      expect(e.session.origin).toEqual({ kind: "dispatch", ref: "ch_1" });
    }
    // The tier chip rides the profile interface (default sealed).
    expect(roster.active[0]!.interface).toBe("orun-sandbox");
  });

  it("joins the needs-you fact: an awaiting implementer is flagged and counted", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo);
    const s = await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_1" }, "running");
    await repo.advanceSession(SCOPE, { publicId: s.publicId, to: "awaiting_approval" });

    const res = await route(req("GET", path("ch_1")), env, makeDeps({ repo }));
    const roster = (await json(res)).data as ChatImplementers;
    expect(roster.active.length).toBe(1);
    expect(roster.needsYou).toBe(1);
    expect(roster.active[0]!.needsYou?.kind).toBe("verdict");
  });

  it("empty when the thread has spawned nothing", async () => {
    const repo = new MemoryAgentsRepository();
    await seedProfile(repo);
    const res = await route(req("GET", path("ch_empty")), env, makeDeps({ repo }));
    const roster = (await json(res)).data as ChatImplementers;
    expect(roster).toEqual({ chatId: "ch_empty", active: [], running: 0, needsYou: 0, done: 0 });
  });

  it("refuses a viewer without session.read (DX lock 4)", async () => {
    const repo = new MemoryAgentsRepository();
    const res = await route(req("GET", path("ch_1")), env, makeDeps({ repo, grants: [] }));
    expect(res.status).toBe(403);
  });

  it("405s a non-GET", async () => {
    const res = await route(req("POST", path("ch_1")), env, makeDeps());
    expect(res.status).toBe(405);
  });
});

describe("foldChatImplementers — the pure fold", () => {
  it("newest active first; terminal fold to a count; unknown profile ⇒ sealed", async () => {
    const repo = new MemoryAgentsRepository();
    const p = await seedProfile(repo);
    const a = await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_1" }, "running");
    const b = await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_1" }, "running");
    await seed(repo, p.publicId, { kind: "dispatch", ref: "ch_1" }, "completed");
    const sessions = await repo.listSessions(SCOPE);
    // Empty interface map ⇒ every entry defaults to orun-sandbox.
    const roster = foldChatImplementers("ch_1", sessions, new Map(), new Map());
    expect(roster.active.map((e) => e.session.id)).toEqual([b.publicId, a.publicId]);
    expect(roster.done).toBe(1);
    expect(roster.active.every((e) => e.interface === "orun-sandbox")).toBe(true);
  });
});
