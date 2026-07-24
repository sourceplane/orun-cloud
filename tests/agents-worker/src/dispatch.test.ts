// Autonomy + dispatch tests (saas-agents AG9, design §7): the ladder gates
// the one dispatch door. Pinned: below auto-dispatch refuses; spec override
// beats the workspace default; the concurrency cap and the one-live-run-per-
// task dedupe hold; a provider-gate refusal still returns the dispatched
// session as requested (parked, retryable).

import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import type { SessionTokenMinter } from "@agents-worker/identity-client";
import type { ProviderKeyClient } from "@agents-worker/config-client";
import type { SandboxProvider } from "@saas/contracts/agents";
import { MemoryAgentsRepository, providerSecretRef } from "@saas/db/agents";
import type { Env } from "@agents-worker/env";

const ORG = "org_b281a9a0f43d463e9c83d6b6597ab2d2"; // public org id carried in the URL
const ORG_UUID = "b281a9a0-f43d-463e-9c83-d6b6597ab2d2"; // what the router decodes to (repo scope)
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

/** A dispatch attributed to a SERVICE PRINCIPAL — the dispatcher acting
 * autonomously (a supervisor turn), gated by the autonomy ladder. */
function spReq(method: string, path: string, body?: unknown): Request {
  return new Request(`https://agents-worker${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-actor-subject-id": "sp_dispatcher",
      "x-actor-subject-type": "service_principal",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json(res: Response): Promise<{ data?: unknown; error?: { code: string; message?: string } }> {
  return (await res.json()) as { data?: unknown; error?: { code: string; message?: string } };
}

const AUTONOMY = `/v1/organizations/${ORG}/agents/autonomy`;
const DISPATCH = `/v1/organizations/${ORG}/agents/dispatch`;

function stubSandbox(): SandboxProvider {
  return {
    id: "daytona",
    async create() {
      return { id: "sb_1", provider: "daytona" };
    },
    async exec() {
      /* ok */
    },
    async snapshot() {
      return "sb_1";
    },
    async resume() {
      return { id: "sb_1", provider: "daytona" };
    },
    async destroy() {
      /* ok */
    },
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

async function fixture(opts?: { connections?: boolean; profiles?: number }): Promise<{
  deps: AgentsDeps;
  repo: MemoryAgentsRepository;
}> {
  const repo = new MemoryAgentsRepository();
  const scope = { orgId: ORG_UUID };
  const n = opts?.profiles ?? 1;
  for (let i = 0; i < n; i++) {
    await repo.createProfile(scope, {
      name: i === 0 ? "impl-default" : `other-${i}`,
      principalId: `sp_${i}`,
      owner: "team/platform",
      agentType: "implementer",
      harness: "claude-code",
      model: "claude-opus-4-8",
    });
  }
  if (opts?.connections !== false) {
    for (const provider of ["daytona", "anthropic"] as const) {
      const c = await repo.createConnection(scope, {
        provider,
        name: "default",
        config: {},
        secretRef: providerSecretRef(provider, "default"),
        createdBy: "usr_rahul",
      });
      await repo.setConnectionStatus(scope, { publicId: c.publicId, status: "verified" });
    }
  }
  const deps: AgentsDeps = {
    repo,
    async authorize() {
      return true;
    },
    providerKeys: keys,
    sessionTokens: minter,
    sandboxes: (p) => (p === "daytona" ? stubSandbox() : null),
    async dispose() {
      /* no-op */
    },
  };
  return { deps, repo };
}

describe("autonomy policy routes (AG9)", () => {
  it("defaults to assist, sets per-workspace and per-spec, spec override wins", async () => {
    const f = await fixture();
    const initial = await route(req("GET", AUTONOMY), env, f.deps);
    expect(((await json(initial)).data as { effectiveLevel: string }).effectiveLevel).toBe("assist");

    expect(
      (await route(req("PUT", AUTONOMY, { level: "auto-dispatch", caps: { maxConcurrent: 2 } }), env, f.deps))
        .status,
    ).toBe(200);
    expect(
      (await route(req("PUT", AUTONOMY, { specKey: "orun-agents", level: "full" }), env, f.deps)).status,
    ).toBe(200);

    const forSpec = await route(req("GET", `${AUTONOMY}?spec=orun-agents`), env, f.deps);
    const body = (await json(forSpec)).data as { effectiveLevel: string; workspaceDefault: { level: string } };
    expect(body.effectiveLevel).toBe("full");
    expect(body.workspaceDefault.level).toBe("auto-dispatch");
  });

  it("rejects a level outside the ladder", async () => {
    const f = await fixture();
    const res = await route(req("PUT", AUTONOMY, { level: "yolo" }), env, f.deps);
    expect(res.status).toBe(422);
  });
});

describe("dispatch (AG9)", () => {
  it("a human-in-the-loop dispatch works at assist (the default) — the AN5 verb contract", async () => {
    // The chat dispatcher acts on the human's in-thread request with the owner's
    // (user) credential; `assist` means the agent dispatches on that request.
    const f = await fixture();
    const res = await route(req("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps);
    expect(res.status).toBe(201);
    expect((await json(res)).data as { dispatched: boolean }).toMatchObject({ dispatched: true });
  });

  it("refuses at manual — a human spawns from the fleet instead", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "manual" }), env, f.deps);
    const res = await route(req("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toContain("manual");
  });

  it("an AUTONOMOUS (service-principal) dispatch still needs auto-dispatch — refused at assist", async () => {
    // A supervisor turn dispatches with the dispatcher principal, no human in
    // the loop; the ladder holds it to auto-dispatch/full.
    const f = await fixture();
    const res = await route(spReq("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps);
    expect(res.status).toBe(409);
    expect((await json(res)).error?.message).toContain("autonomous dispatch needs auto-dispatch");
  });

  it("an autonomous dispatch is allowed once the workspace opts into auto-dispatch", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "auto-dispatch" }), env, f.deps);
    const res = await route(spReq("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps);
    expect(res.status).toBe(201);
    expect((await json(res)).data as { dispatched: boolean }).toMatchObject({ dispatched: true });
  });

  it("dispatches at auto-dispatch: session created, provisioned, task + workRef carried", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "auto-dispatch" }), env, f.deps);
    const res = await route(req("POST", DISPATCH, { taskKey: "ORN-1", specKey: "orun-agents" }), env, f.deps);
    expect(res.status).toBe(201);
    const body = (await json(res)).data as {
      dispatched: boolean;
      provisioned: boolean;
      session: { state: string; taskKey: string; workRef: string };
    };
    expect(body.dispatched).toBe(true);
    expect(body.provisioned).toBe(true);
    expect(body.session.state).toBe("provisioning");
    expect(body.session.taskKey).toBe("ORN-1");
    expect(body.session.workRef).toBe(`work://${ORG}/orun-agents`);
  });

  it("dedupes: one live run per task", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "full" }), env, f.deps);
    expect((await route(req("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps)).status).toBe(201);
    const dup = await route(req("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps);
    expect(dup.status).toBe(409);
    expect((await json(dup)).error?.message).toContain("already working");
  });

  it("enforces the concurrency cap from policy caps", async () => {
    const f = await fixture();
    await route(req("PUT", AUTONOMY, { level: "full", caps: { maxConcurrent: 1 } }), env, f.deps);
    expect((await route(req("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps)).status).toBe(201);
    const capped = await route(req("POST", DISPATCH, { taskKey: "ORN-2" }), env, f.deps);
    expect(capped.status).toBe(409);
    expect((await json(capped)).error?.message).toContain("cap");
  });

  it("parks the session as requested when the provider gate refuses", async () => {
    const f = await fixture({ connections: false });
    await route(req("PUT", AUTONOMY, { level: "auto-dispatch" }), env, f.deps);
    const res = await route(req("POST", DISPATCH, { taskKey: "ORN-9" }), env, f.deps);
    expect(res.status).toBe(201);
    const body = (await json(res)).data as { provisioned: boolean; gate: string; session: { state: string } };
    expect(body.provisioned).toBe(false);
    expect(body.gate).toContain("daytona");
    expect(body.session.state).toBe("requested");
  });

  it("404s when no dispatchable profile resolves", async () => {
    const f = await fixture({ profiles: 0 });
    await route(req("PUT", AUTONOMY, { level: "full" }), env, f.deps);
    const res = await route(req("POST", DISPATCH, { taskKey: "ORN-1" }), env, f.deps);
    expect(res.status).toBe(404);
    expect((await json(res)).error?.code).toBe("agent_profile_not_found");
  });

  it("validates the body and 405s wrong methods", async () => {
    const f = await fixture();
    expect((await route(req("POST", DISPATCH, {}), env, f.deps)).status).toBe(422);
    expect((await route(req("GET", DISPATCH), env, f.deps)).status).toBe(405);
    expect((await route(req("POST", AUTONOMY, { level: "full" }), env, f.deps)).status).toBe(405);
  });
});
