// Dependency seam for the agents control-plane handlers. The real path builds
// a Postgres-backed repository from PLATFORM_DB and authorizes through the
// membership + policy workers; unit tests inject a MemoryAgentsRepository and a
// stub authorizer, so route() is drivable with no live bindings (the
// create-setting.ts `deps` pattern).

import type { AgentsRepository } from "@saas/db/agents";
import { createAgentsRepository } from "@saas/db/agents";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";
import type { PolicyResource } from "@saas/contracts/policy";
import { createProviderKeyClient, type ProviderKeyClient } from "./config-client.js";
import { createProviderVerifier, type ProviderVerifier } from "./verifiers.js";

export interface AgentsDeps {
  repo: AgentsRepository;
  /** Deny-by-default authorization; every control-plane action passes through. */
  authorize(action: string, orgId: string, actor: ActorContext, requestId: string): Promise<boolean>;
  /** Provider-key custody client (config-worker service binding). Absent when
   * CONFIG_WORKER is unbound — provider routes then 503. */
  providerKeys?: ProviderKeyClient;
  /** Provider verification pings (AG12 §10.3); stubbed in tests. */
  verifier?: ProviderVerifier;
  /** Release any resources (a real DB executor) after the request. */
  dispose(): Promise<void>;
}

/** True when the production bindings needed to serve are present. */
export function ready(env: Env): boolean {
  return !!env.PLATFORM_DB && !!env.MEMBERSHIP_WORKER && !!env.POLICY_WORKER;
}

/** Build the production deps from env bindings (caller must check ready()). */
export function buildDeps(env: Env): AgentsDeps {
  const executor = createSqlExecutor(env.PLATFORM_DB!);
  const repo = createAgentsRepository(executor);
  return {
    repo,
    ...(env.CONFIG_WORKER ? { providerKeys: createProviderKeyClient(env.CONFIG_WORKER) } : {}),
    verifier: createProviderVerifier(),
    async authorize(action, orgId, actor, requestId) {
      const ctx = await fetchAuthorizationContext(
        env.MEMBERSHIP_WORKER!,
        actor.subjectId,
        actor.subjectType,
        orgId,
        requestId,
      );
      if (!ctx.ok) return false;
      const resource: PolicyResource = { kind: "organization", orgId };
      const res = await authorizeViaPolicy(
        env.POLICY_WORKER!,
        actor.subjectId,
        actor.subjectType,
        action,
        resource,
        ctx.memberships,
        requestId,
      );
      return res.allow;
    },
    async dispose() {
      await executor.dispose();
    },
  };
}
