// AG10 metering + entitlement tests (design §8). Pinned: the feature.agents
// gate is D3-OPEN (only an explicit plan disable denies — not_configured and
// billing hiccups allow), the deny carries the upgrade path, and exactly one
// agents.sessions_started sample rides a successful boot — never a failed one.

import { route } from "@agents-worker/router";
import type { AgentsDeps } from "@agents-worker/deps";
import { decideAgentsFeature } from "@agents-worker/billing-client";
import type { SessionTokenMinter } from "@agents-worker/identity-client";
import type { ProviderKeyClient } from "@agents-worker/config-client";
import type { SandboxProvider } from "@saas/contracts/agents";
import type { CheckBillingEntitlementResponse } from "@saas/contracts/billing";
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

function decision(over: Partial<CheckBillingEntitlementResponse>): CheckBillingEntitlementResponse {
  return {
    orgId: ORG,
    entitlementKey: "feature.agents",
    allowed: true,
    valueType: "boolean",
    limitValue: null,
    reason: "plan",
    ...over,
  } as CheckBillingEntitlementResponse;
}

describe("feature.agents decision (AG10)", () => {
  it("is open by default: not_configured and service errors allow", () => {
    expect(decideAgentsFeature({ kind: "service_error" }).kind).toBe("allow");
    expect(
      decideAgentsFeature({ kind: "decision", decision: decision({ allowed: false, reason: "not_configured" }) })
        .kind,
    ).toBe("allow");
    expect(decideAgentsFeature({ kind: "decision", decision: decision({ allowed: true }) }).kind).toBe("allow");
  });

  it("denies only an explicit plan disable, with the upgrade path", () => {
    const gate = decideAgentsFeature({
      kind: "decision",
      decision: decision({ allowed: false, reason: "disabled" }),
    });
    expect(gate.kind).toBe("deny");
    expect(gate.kind === "deny" && gate.message).toContain("upgrade");
  });
});

describe("dispatch entitlement gate + provision usage emission (AG10)", () => {
  const stubSandbox: SandboxProvider = {
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
  const keys: ProviderKeyClient = {
    async store() {
      return true;
    },
    async resolve() {
      return "key";
    },
  };
  const minter: SessionTokenMinter = {
    async mint() {
      return { token: "ast", expiresAt: "2099-01-01T00:00:00Z" };
    },
  };

  async function fixture(gate: "allow" | "deny"): Promise<{
    deps: AgentsDeps;
    usage: Array<{ metric: string; quantity: number; dims: Record<string, string> }>;
  }> {
    const repo = new MemoryAgentsRepository();
    const scope = { orgId: ORG_UUID };
    await repo.createProfile(scope, {
      name: "impl-default",
      principalId: "sp_1",
      owner: "team/platform",
      agentType: "implementer",
      harness: "claude-code",
      model: "claude-opus-4-8",
    });
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
    await repo.setAutonomy(scope, { level: "full" });

    const usage: Array<{ metric: string; quantity: number; dims: Record<string, string> }> = [];
    const deps: AgentsDeps = {
      repo,
      async authorize() {
        return true;
      },
      providerKeys: keys,
      sessionTokens: minter,
      sandboxes: (p) => (p === "daytona" ? stubSandbox : null),
      entitlement: async () =>
        gate === "deny" ? { kind: "deny", message: "upgrade to dispatch agents" } : { kind: "allow" },
      usage: {
        async record(_orgId, metric, quantity, dims) {
          usage.push({ metric, quantity, dims });
        },
      },
      async dispose() {
        /* no-op */
      },
    };
    return { deps, usage };
  }

  it("403s dispatch when the plan disables agents", async () => {
    const f = await fixture("deny");
    const res = await route(req("POST", `/v1/organizations/${ORG}/agents/dispatch`, { taskKey: "ORN-1" }), env, f.deps);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("upgrade");
    expect(f.usage.length).toBe(0);
  });

  it("emits exactly one agents.sessions_started on a successful boot", async () => {
    const f = await fixture("allow");
    const res = await route(req("POST", `/v1/organizations/${ORG}/agents/dispatch`, { taskKey: "ORN-1" }), env, f.deps);
    expect(res.status).toBe(201);
    expect(f.usage).toEqual([
      {
        metric: "agents.sessions_started",
        quantity: 1,
        dims: { runKind: "implementation", profile: expect.stringMatching(/^agp_/) },
      },
    ]);
  });

  it("emits nothing when provisioning fails at the gate", async () => {
    const f = await fixture("allow");
    // Remove the connections so the spawn gate refuses.
    for (const c of await f.deps.repo.listConnections({ orgId: ORG_UUID })) {
      await f.deps.repo.deleteConnection({ orgId: ORG_UUID }, c.publicId);
    }
    const res = await route(req("POST", `/v1/organizations/${ORG}/agents/dispatch`, { taskKey: "ORN-2" }), env, f.deps);
    expect(res.status).toBe(201); // dispatched-but-parked
    expect(f.usage.length).toBe(0);
  });
});
