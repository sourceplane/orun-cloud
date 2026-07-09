// Session provisioning tests (saas-agents AG5 live slice): the spawn gate over
// AG12 connections. Pinned invariants: fail-loud gate (missing/unverified
// connection refuses BEFORE any provider call), the model key rides the exec
// env only, half-booted sandboxes are destroyed, and failures land the session
// as `failed` with a redacted reason.

import { route } from "@agents-worker/router";
import type { AgentsDeps, SandboxFactory } from "@agents-worker/deps";
import type { ProviderKeyClient } from "@agents-worker/config-client";
import type { SessionTokenMinter } from "@agents-worker/identity-client";
import type { SandboxProvider, SandboxSpec, SandboxRef } from "@saas/contracts/agents";
import { MemoryAgentsRepository, providerSecretRef } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_test";
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

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string; message?: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string; message?: string } };
}

interface ProviderLog {
  created: SandboxSpec[];
  execs: Array<{ ref: SandboxRef; cmd: string[]; env?: Record<string, string> }>;
  destroyed: string[];
}

function stubProvider(log: ProviderLog, overrides?: { failCreate?: boolean; failExec?: boolean }): SandboxProvider {
  return {
    id: "daytona",
    async create(spec) {
      if (overrides?.failCreate) throw new Error("503 from provider");
      log.created.push(spec);
      return { id: "sb_1", provider: "daytona" };
    },
    async exec(ref, cmd, opts) {
      if (overrides?.failExec) throw new Error("exec refused");
      log.execs.push({ ref, cmd, ...(opts?.env ? { env: opts.env } : {}) });
    },
    async snapshot() {
      return "sb_1";
    },
    async resume() {
      return { id: "sb_1", provider: "daytona" };
    },
    async destroy(ref) {
      log.destroyed.push(ref.id);
    },
    async health() {
      return { healthy: true };
    },
  };
}

function makeKeys(values: Record<string, string | null> = {}): ProviderKeyClient {
  return {
    async store() {
      return true;
    },
    async resolve(_orgId, key) {
      if (key in values) return values[key]!;
      return `key-for(${key})`;
    },
  };
}

interface Fixture {
  deps: AgentsDeps;
  repo: MemoryAgentsRepository;
  log: ProviderLog;
  sessionId: string;
}

async function fixture(overrides?: {
  allow?: boolean;
  keys?: ProviderKeyClient;
  factory?: SandboxFactory;
  minter?: SessionTokenMinter;
  connections?: Array<{ provider: "daytona" | "anthropic"; name?: string; verified?: boolean; config?: Record<string, unknown> }>;
  providerOverrides?: { failCreate?: boolean; failExec?: boolean };
}): Promise<Fixture> {
  const repo = new MemoryAgentsRepository();
  const log: ProviderLog = { created: [], execs: [], destroyed: [] };
  const scope = { orgId: ORG };

  const profile = await repo.createProfile(scope, {
    name: "impl",
    principalId: "sp_1",
    owner: "team/platform",
    agentType: "implementer",
    harness: "claude-code",
    model: "claude-opus-4-8",
  });
  const session = await repo.createSession(scope, {
    profileId: profile.publicId,
    runKind: "implementation",
    spawnedBy: "usr_rahul",
    taskKey: "ORN-142",
  });

  const conns = overrides?.connections ?? [
    { provider: "daytona" as const, verified: true },
    { provider: "anthropic" as const, verified: true },
  ];
  for (const c of conns) {
    const name = c.name ?? "default";
    const row = await repo.createConnection(scope, {
      provider: c.provider,
      name,
      config: c.config ?? {},
      secretRef: providerSecretRef(c.provider, name),
      createdBy: "usr_rahul",
    });
    if (c.verified !== false) {
      await repo.setConnectionStatus(scope, { publicId: row.publicId, status: "verified" });
    }
  }

  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return overrides?.allow ?? true;
    },
    providerKeys: overrides?.keys ?? makeKeys(),
    sessionTokens:
      overrides?.minter ??
      ({
        async mint(principalId, orgId, sid) {
          return { token: `ast(${principalId},${orgId},${sid})`, expiresAt: "2099-01-01T00:00:00Z" };
        },
      } satisfies SessionTokenMinter),
    sandboxes:
      overrides?.factory ??
      ((provider) => (provider === "daytona" ? stubProvider(log, overrides?.providerOverrides) : null)),
    async dispose() {
      /* no-op */
    },
  };
  return { deps, repo, log, sessionId: session.publicId };
}

const provisionPath = (id: string) => `/v1/organizations/${ORG}/agents/sessions/${id}/provision`;

describe("agents-worker session provisioning (AG5)", () => {
  it("provisions: creates the sandbox, execs orun agent serve with the model key, records the ref", async () => {
    const f = await fixture();
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(200);
    const s = (await json(res)).data as { state: string };
    expect(s.state).toBe("provisioning");

    // Create-time env is non-secret; the model key rides the exec only.
    expect(f.log.created.length).toBe(1);
    const spec = f.log.created[0]!;
    expect(spec.baseSnapshot).toBe("agents-base");
    expect(spec.env).toEqual({
      ORUN_SESSION_ID: f.sessionId,
      ORUN_ORG_ID: ORG,
      ORUN_RUN_KIND: "implementation",
      ORUN_TASK_KEY: "ORN-142",
    });
    expect(JSON.stringify(spec.env)).not.toContain("key-for");

    expect(f.log.execs.length).toBe(1);
    expect(f.log.execs[0]!.cmd).toEqual(["orun", "agent", "serve"]);
    expect(f.log.execs[0]!.env).toEqual({
      ANTHROPIC_API_KEY: "key-for(agents/providers/anthropic/default/API_KEY)",
      ORUN_SESSION_TOKEN: `ast(sp_1,${ORG},${f.sessionId})`,
    });

    // The recorded sandbox carries the provider ref, never key material.
    const stored = await f.repo.getSession({ orgId: ORG }, f.sessionId);
    expect(stored?.sandbox).toEqual({ provider: "daytona", id: "sb_1", connection: expect.stringMatching(/^apc_/) });
  });

  it("honors connection config: snapshot + ttl flow into the spec", async () => {
    const f = await fixture({
      connections: [
        { provider: "daytona", config: { snapshot: "agents-base@v3", ttlSeconds: 900 } },
        { provider: "anthropic" },
      ],
    });
    await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(f.log.created[0]!.baseSnapshot).toBe("agents-base@v3");
    expect(f.log.created[0]!.ttlSeconds).toBe(900);
  });

  it("refuses at the gate when the daytona connection is missing — no provider call", async () => {
    const f = await fixture({ connections: [{ provider: "anthropic" }] });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("provider_connection_invalid");
    expect(f.log.created.length).toBe(0);
    // The session is untouched — still requested, retryable after connecting.
    expect((await f.repo.getSession({ orgId: ORG }, f.sessionId))?.state).toBe("requested");
  });

  it("refuses an unverified/invalid connection at the gate", async () => {
    const f = await fixture({
      connections: [{ provider: "daytona", verified: false }, { provider: "anthropic" }],
    });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toContain("unverified");
    expect(f.log.created.length).toBe(0);
  });

  it("picks the default-named connection among several", async () => {
    const f = await fixture({
      connections: [
        { provider: "daytona", name: "staging", config: { snapshot: "wrong" } },
        { provider: "daytona", name: "default", config: { snapshot: "right" } },
        { provider: "anthropic" },
      ],
    });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(200);
    expect(f.log.created[0]!.baseSnapshot).toBe("right");
  });

  it("409s when key material does not resolve", async () => {
    const f = await fixture({
      keys: makeKeys({ [providerSecretRef("daytona", "default")]: null }),
    });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(409);
    expect(f.log.created.length).toBe(0);
  });

  it("lands the session as failed with a redacted reason when create fails", async () => {
    const f = await fixture({ providerOverrides: { failCreate: true } });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(502);
    const body = await json(res);
    expect(body.error?.code).toBe("provider_verification_failed");
    expect(JSON.stringify(body)).not.toContain("key-for");
    expect((await f.repo.getSession({ orgId: ORG }, f.sessionId))?.state).toBe("failed");
  });

  it("destroys the half-booted sandbox when exec fails", async () => {
    const f = await fixture({ providerOverrides: { failExec: true } });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(502);
    expect(f.log.destroyed).toEqual(["sb_1"]);
    expect((await f.repo.getSession({ orgId: ORG }, f.sessionId))?.state).toBe("failed");
  });

  it("409s a session that is not in requested state", async () => {
    const f = await fixture();
    await f.repo.advanceSession({ orgId: ORG }, { publicId: f.sessionId, to: "provisioning" });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe("conflict");
  });

  it("404s an unknown session; 403s when policy denies; 405s a GET", async () => {
    const f = await fixture();
    expect((await route(req("POST", provisionPath("as_missing")), env, f.deps)).status).toBe(404);

    const denied = await fixture({ allow: false });
    expect((await route(req("POST", provisionPath(denied.sessionId)), env, denied.deps)).status).toBe(403);

    expect((await route(req("GET", provisionPath(f.sessionId)), env, f.deps)).status).toBe(405);
  });

  it("502s with no provider call when the session credential mint fails", async () => {
    const f = await fixture({
      minter: {
        async mint() {
          return null;
        },
      },
    });
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(502);
    expect(f.log.created.length).toBe(0);
    expect((await f.repo.getSession({ orgId: ORG }, f.sessionId))?.state).toBe("requested");
  });

  it("503s when no sandbox factory is bound", async () => {
    const f = await fixture();
    delete f.deps.sandboxes;
    const res = await route(req("POST", provisionPath(f.sessionId)), env, f.deps);
    expect(res.status).toBe(503);
  });
});
