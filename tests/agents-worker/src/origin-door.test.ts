// Origin taint at the door (saas-agent-supervision SV0, design §2). The five
// provenances each land the expected origin when they ring the AG9 door; a
// client-supplied `origin` body field is IGNORED (provenance comes from the
// authenticated caller's context, never the body); and origin is immutable —
// advancing a session's state never rewrites it.

import { route } from "@agents-worker/router";
import { dispatchRoutineFiring } from "@agents-worker/handlers/dispatch";
import type { AgentsDeps } from "@agents-worker/deps";
import type { SessionTokenMinter } from "@agents-worker/identity-client";
import type { ProviderKeyClient } from "@agents-worker/config-client";
import type { SandboxProvider, AgentSession as WireSession, AgentOrigin } from "@saas/contracts/agents";
import { MemoryAgentsRepository, providerSecretRef } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const SCOPE = { orgId: ORG_UUID };
const env: Env = { ENVIRONMENT: "test" };

function req(method: string, path: string, body?: unknown, actorExtra: Record<string, string> = {}): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
      ...actorExtra,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string; message?: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string; message?: string } };
}

function stubSandbox(): SandboxProvider {
  return {
    id: "daytona",
    async create() {
      return { id: "sb_1", provider: "daytona" };
    },
    async exec() {},
    async snapshot() {
      return "sb_1";
    },
    async resume() {
      return { id: "sb_1", provider: "daytona" };
    },
    async destroy() {},
    async health() {
      return { healthy: true };
    },
  };
}

const keys: ProviderKeyClient = {
  async store() {
    return true;
  },
  async resolve() {
    return "key";
  },
  async revoke() {
    return true;
  },
};
const minter: SessionTokenMinter = {
  async mint() {
    return { token: "ast", expiresAt: "2099-01-01T00:00:00Z" };
  },
};

async function fixture(): Promise<{ deps: AgentsDeps; repo: MemoryAgentsRepository; profileId: string }> {
  const repo = new MemoryAgentsRepository();
  const profile = await repo.createProfile(SCOPE, {
    name: "impl-default",
    principalId: "sp_agent1",
    owner: "team/platform",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
  for (const provider of ["daytona", "anthropic"] as const) {
    const c = await repo.createConnection(SCOPE, {
      provider,
      name: "default",
      config: {},
      secretRef: providerSecretRef(provider, "default"),
      createdBy: "usr_rahul",
    });
    await repo.setConnectionStatus(SCOPE, { publicId: c.publicId, status: "verified" });
  }
  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return true;
    },
    providerKeys: keys,
    sessionTokens: minter,
    sandboxes: (p) => (p === "daytona" ? stubSandbox() : null),
    async dispose() {},
  };
  return { deps, repo, profileId: profile.publicId };
}

/** The origin recorded on the freshly-created row, read straight from the repo
 * (the authoritative store — not just the wire projection). */
async function originOf(repo: MemoryAgentsRepository, publicId: string): Promise<AgentOrigin> {
  const s = await repo.getSession(SCOPE, publicId);
  if (!s) throw new Error(`no session ${publicId}`);
  return s.origin;
}

const SESSIONS = `/v1/organizations/${ORG}/agents/sessions`;
const DISPATCH = `/v1/organizations/${ORG}/agents/dispatch`;
const AUTONOMY = `/v1/organizations/${ORG}/agents/autonomy`;

describe("origin taint — the five provenances (SV0 §2.2)", () => {
  it("human: a direct POST /sessions lands origin=human, no ref", async () => {
    const f = await fixture();
    const res = await route(req("POST", SESSIONS, { profileId: f.profileId, runKind: "interactive" }), env, f.deps);
    expect(res.status).toBe(201);
    const s = (await json(res)).data as WireSession;
    expect(s.origin).toEqual({ kind: "human" });
    expect(await originOf(f.repo, s.id)).toEqual({ kind: "human" });
  });

  it("session: a parent-session spawn lands origin=session, ref=parent", async () => {
    const f = await fixture();
    const parent = await f.repo.createSession(SCOPE, {
      profileId: f.profileId,
      runKind: "implementation",
      spawnedBy: "usr_rahul",
    });
    await f.repo.advanceSession(SCOPE, { publicId: parent.publicId, to: "provisioning" });
    await f.repo.advanceSession(SCOPE, { publicId: parent.publicId, to: "running" });
    const res = await route(
      req("POST", SESSIONS, { profileId: f.profileId, runKind: "implementation" }, {
        "x-actor-subject-id": "sp_agent1",
        "x-actor-subject-type": "service_principal",
        "x-actor-agent-session-id": parent.publicId,
      }),
      env,
      f.deps,
    );
    expect(res.status).toBe(201);
    const child = (await json(res)).data as WireSession;
    expect(child.origin).toEqual({ kind: "session", ref: parent.publicId });
  });

  it("work: a POST /dispatch task (no dispatchRef) lands origin=work, ref=taskKey", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "auto-dispatch" }), env, f.deps);
    const res = await route(req("POST", DISPATCH, { taskKey: "ORN-142" }), env, f.deps);
    expect(res.status).toBe(201);
    const s = (await json(res)).data as { session: WireSession };
    expect(s.session.origin).toEqual({ kind: "work", ref: "ORN-142", label: "ORN-142" });
  });

  it("dispatch: a POST /dispatch carrying dispatchRef lands origin=dispatch, ref=thread", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "auto-dispatch" }), env, f.deps);
    const res = await route(
      req("POST", DISPATCH, { taskKey: "ORN-7", dispatchRef: "ch_thread1", dispatchLabel: "Fix flaky CI" }),
      env,
      f.deps,
    );
    expect(res.status).toBe(201);
    const s = (await json(res)).data as { session: WireSession };
    expect(s.session.origin).toEqual({ kind: "dispatch", ref: "ch_thread1", label: "Fix flaky CI" });
  });

  it("routine: a routine firing lands origin=routine, ref=routine id", async () => {
    const f = await fixture();
    const routine = await f.repo.createRoutine(SCOPE, {
      name: "nightly-triage",
      profileId: f.profileId,
      runKind: "implementation",
      triggerKind: "cron",
      triggerConfig: { cron: "0 7 * * *" },
      createdBy: "usr_rahul",
    });
    const res = await dispatchRoutineFiring(f.deps, ORG_UUID, routine.publicId, {
      subjectId: "usr_rahul",
      subjectType: "user",
    }, "req_1");
    expect(res.status).toBe(201);
    const s = (await json(res)).data as { session: WireSession };
    expect(s.session.origin).toEqual({ kind: "routine", ref: routine.publicId, label: "nightly-triage" });
  });
});

describe("origin is door-recorded, never body-supplied (SV0 §2.1)", () => {
  it("ignores a forged `origin` in the create body — a human spawn stays human", async () => {
    const f = await fixture();
    const res = await route(
      req("POST", SESSIONS, {
        profileId: f.profileId,
        runKind: "interactive",
        // A body cannot claim a provenance it does not hold.
        origin: { kind: "dispatch", ref: "ch_evil", label: "totally legit" },
      }),
      env,
      f.deps,
    );
    expect(res.status).toBe(201);
    const s = (await json(res)).data as WireSession;
    expect(s.origin).toEqual({ kind: "human" });
  });

  it("ignores a forged `origin` on the dispatch path — the door decides work vs dispatch", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "auto-dispatch" }), env, f.deps);
    const res = await route(
      req("POST", DISPATCH, { taskKey: "ORN-3", origin: { kind: "human" } }),
      env,
      f.deps,
    );
    expect(res.status).toBe(201);
    const s = (await json(res)).data as { session: WireSession };
    // The `origin` body field was ignored; absence of dispatchRef ⇒ work.
    expect(s.session.origin.kind).toBe("work");
  });
});

describe("origin is immutable (SV0 §2.1)", () => {
  it("advancing state never rewrites origin", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "auto-dispatch" }), env, f.deps);
    const res = await route(
      req("POST", DISPATCH, { taskKey: "ORN-5", dispatchRef: "ch_thread9" }),
      env,
      f.deps,
    );
    const s = (await json(res)).data as { session: WireSession };
    const before = await originOf(f.repo, s.session.id);
    // Drive it to a terminal state through the normal mutator.
    await f.repo.advanceSession(SCOPE, { publicId: s.session.id, to: "running" });
    await f.repo.advanceSession(SCOPE, { publicId: s.session.id, to: "completing" });
    await f.repo.advanceSession(SCOPE, { publicId: s.session.id, to: "completed" });
    expect(await originOf(f.repo, s.session.id)).toEqual(before);
    expect(before).toEqual({ kind: "dispatch", ref: "ch_thread9" });
  });
});
