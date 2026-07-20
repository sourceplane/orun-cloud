// The anthropic-managed provision path (saas-dispatch DX7). Pinned
// invariants: the no-ask gate refuses a managed profile without an explicit
// definition-time tools allowlist (interface_requires_ask) BEFORE any
// provider call; a managed spawn needs NO Daytona connection; the session
// advances straight to running (no heartbeat exists on this interface); a
// provider failure lands failed with a redacted reason; the profile create
// route validates + persists the interface and capability ceiling.

import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import type { ProviderKeyClient } from "@agents-worker/config-client";
import type { ManagedAgentsAdapter, ManagedSpawnSpec } from "@agents-worker/providers/managed-agents";
import { ManagedAgentsError } from "@agents-worker/providers/managed-agents";
import { MemoryAgentsRepository, providerSecretRef } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2";
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2";
const env: Env = { ENVIRONMENT: "test" };

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "usr_rahul",
      "x-actor-subject-type": "user",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: any; error?: { code: string; message?: string } }> {
  return (await res.json()) as never;
}

function quietWarn(): () => void {
  const orig = console.warn;
  console.warn = () => {};
  return () => void (console.warn = orig);
}

function makeKeys(): ProviderKeyClient {
  return {
    async store() {
      return true;
    },
    async resolve(_orgId, key) {
      return `key-for(${key})`;
    },
  };
}

function stubAdapter(overrides?: { failSpawn?: boolean }): {
  adapter: ManagedAgentsAdapter;
  spawns: ManagedSpawnSpec[];
} {
  const spawns: ManagedSpawnSpec[] = [];
  return {
    spawns,
    adapter: {
      async spawn(spec) {
        if (overrides?.failSpawn) throw new ManagedAgentsError("session.create", "429 from provider");
        spawns.push(spec);
        return { provider: "anthropic-managed", agentId: "ma_a1", sessionId: "ma_s1" };
      },
      async send() {},
      async interrupt() {},
      async archive() {},
    },
  };
}

async function fixture(overrides?: {
  tools?: string[] | null;
  failSpawn?: boolean;
  usage?: Array<{ metric: string }>;
}) {
  const repo = new MemoryAgentsRepository();
  const scope = { orgId: ORG_UUID };
  const capability =
    overrides?.tools === null ? {} : { tools: overrides?.tools ?? ["catalog", "work"] };
  const profile = await repo.createProfile(scope, {
    name: "quick-triage",
    principalId: "sp_1",
    owner: "team/platform",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
    interface: "anthropic-managed",
    capability,
  });
  const session = await repo.createSession(scope, {
    profileId: profile.publicId,
    runKind: "interactive",
    spawnedBy: "usr_rahul",
    taskKey: "ORN-9",
  });
  // Only the ANTHROPIC connection exists — a managed spawn must not need Daytona.
  const conn = await repo.createConnection(scope, {
    provider: "anthropic",
    name: "default",
    config: {},
    secretRef: providerSecretRef("anthropic", "default"),
    createdBy: "usr_rahul",
  });
  await repo.setConnectionStatus(scope, { publicId: conn.publicId, status: "verified" });

  const { adapter, spawns } = stubAdapter({ ...(overrides?.failSpawn ? { failSpawn: true } : {}) });
  const usage = overrides?.usage ?? [];
  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return true;
    },
    providerKeys: makeKeys(),
    managedAgents: () => adapter,
    usage: {
      async record(_orgId: string, metric: string) {
        usage.push({ metric });
      },
    } as never,
    async dispose() {},
  } as AgentsDeps;
  return { repo, deps, session, spawns, usage };
}

const provisionPath = (id: string) => `/v1/organizations/${ORG}/agents/sessions/${id}/provision`;

describe("anthropic-managed provisioning (DX7)", () => {
  it("refuses a managed profile without a tools allowlist: interface_requires_ask, before any provider call", async () => {
    const restore = quietWarn();
    const { deps, session, spawns } = await fixture({ tools: null });
    const res = await route(req("POST", provisionPath(session.publicId)), env, deps);
    restore();
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error?.code).toBe("interface_requires_ask");
    expect(body.error?.message).toContain("capability.tools");
    expect(spawns).toHaveLength(0);
  });

  it("spawns through the adapter and advances straight to running — no Daytona, no heartbeat wait", async () => {
    const restore = quietWarn();
    const { repo, deps, session, spawns, usage } = await fixture({ usage: [] });
    const res = await route(req("POST", provisionPath(session.publicId)), env, deps);
    restore();
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.state).toBe("running");

    expect(spawns).toHaveLength(1);
    const spec = spawns[0]!;
    expect(spec.model).toBe("claude-opus-4-8");
    expect(spec.tools).toEqual(["catalog", "work"]);
    expect(spec.brief).toContain("ORN-9");
    expect(spec.title).toBe("ORN-9");

    const stored = await repo.getSession({ orgId: ORG_UUID }, session.publicId);
    expect(stored!.sandbox).toMatchObject({ provider: "anthropic-managed", id: "ma_s1", agentId: "ma_a1" });
    expect(usage.map((u) => u.metric)).toEqual(["agents.sessions_started"]);
  });

  it("lands failed with a redacted reason when the provider refuses", async () => {
    const restore = quietWarn();
    const { repo, deps, session } = await fixture({ failSpawn: true });
    const res = await route(req("POST", provisionPath(session.publicId)), env, deps);
    restore();
    expect(res.status).toBe(502);
    const stored = await repo.getSession({ orgId: ORG_UUID }, session.publicId);
    expect(stored!.state).toBe("failed");
    expect(stored!.sandbox.error).toBe("session.create: 429 from provider");
  });
});

describe("profile interface plumbing (DX7)", () => {
  it("validates the interface vocabulary on create and persists interface + capability", async () => {
    const repo = new MemoryAgentsRepository();
    const deps: AgentsDeps = {
      repo,
      async authorize() {
        return true;
      },
      async dispose() {},
    } as AgentsDeps;
    const path = `/v1/organizations/${ORG}/agents/profiles`;
    const junk = await route(
      req("POST", path, {
        name: "x",
        principalId: "sp_1",
        owner: "u",
        agentType: "implementer",
        harness: "claude-code",
        model: "m",
        interface: "gpu-cluster",
      }),
      env,
      deps,
    );
    expect(junk.status).toBe(422);

    const ok = await route(
      req("POST", path, {
        name: "managed-triage",
        principalId: "sp_1",
        owner: "u",
        agentType: "implementer",
        harness: "claude-code",
        model: "m",
        interface: "anthropic-managed",
        capability: { tools: ["catalog"] },
      }),
      env,
      deps,
    );
    expect(ok.status).toBe(201);
    const body = await json(ok);
    expect(body.data.interface).toBe("anthropic-managed");
    const stored = await repo.getProfile({ orgId: ORG_UUID }, "managed-triage");
    expect(stored!.interface).toBe("anthropic-managed");
    expect(stored!.capability).toEqual({ tools: ["catalog"] });
  });

  it("defaults to orun-sandbox — prior behavior untouched", async () => {
    const repo = new MemoryAgentsRepository();
    const profile = await repo.createProfile(
      { orgId: ORG_UUID },
      { name: "plain", principalId: "sp_1", owner: "u", agentType: "implementer", harness: "h", model: "m" },
    );
    expect(profile.interface).toBe("orun-sandbox");
  });
});
