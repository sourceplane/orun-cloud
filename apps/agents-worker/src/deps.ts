// Dependency seam for the agents control-plane handlers. The real path builds
// a Postgres-backed repository from PLATFORM_DB and authorizes through the
// membership + policy workers; unit tests inject a MemoryAgentsRepository and a
// stub authorizer, so route() is drivable with no live bindings (the
// create-setting.ts `deps` pattern).

import type { AgentsRepository } from "@saas/db/agents";
import { createAgentsRepository } from "@saas/db/agents";
import type { IntegrationsRepository } from "@saas/db/integrations";
import { createIntegrationsRepository } from "@saas/db/integrations";
import type { EventsRepository } from "@saas/db/events";
import { createEventsRepository } from "@saas/db/events";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { Env } from "./env.js";
import type { ActorContext } from "./router.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";
import type { PolicyResource } from "@saas/contracts/policy";
import {
  createOrgSettingReader,
  createProviderKeyClient,
  type OrgSettingReader,
  type ProviderKeyClient,
} from "./config-client.js";
import { createProviderVerifier, type ProviderVerifier } from "./verifiers.js";
import { createDaytonaProvider } from "./providers/daytona.js";
import { createManagedAgentsAdapter, type ManagedAgentsAdapter } from "./providers/managed-agents.js";
import { createSessionTokenMinter, type SessionTokenMinter } from "./identity-client.js";
import { checkBillingEntitlement, decideAgentsFeature, type AgentsEntitlementGate } from "./billing-client.js";
import { createUsageRecorder, type UsageRecorder } from "./metering-client.js";
import type { SandboxProvider } from "@saas/contracts/agents";

/** Builds the sandbox adapter for a provider connection (AG5 seam); null when
 * no adapter exists for the provider. */
export type SandboxFactory = (
  provider: string,
  apiKey: string,
  config: Record<string, unknown>,
) => SandboxProvider | null;

/**
 * The slice of the integrations repository the IR5 dual-write needs (identity
 * rows in integrations.connections beside the agents facts rows). Narrow so
 * tests fake three methods, not the whole repository.
 */
export type IntegrationConnectionsMirror = Pick<
  IntegrationsRepository,
  "createConnection" | "activateConnection" | "updateConnectionStatus"
>;

/** The audit-emission slice (IR5: `integration.connected/…` now also fires on
 *  the re-homed lifecycle — previously silent panel writes). */
export type AuditEmitter = Pick<EventsRepository, "appendEventWithAudit">;

export interface AgentsDeps {
  repo: AgentsRepository;
  /** Deny-by-default authorization; every control-plane action passes through. */
  authorize(action: string, orgId: string, actor: ActorContext, requestId: string): Promise<boolean>;
  /** IR5 dual-write seam: the integrations.connections identity rows. Absent
   *  (tests without a DB) = agents rows only, connection_id stays null —
   *  the same pre-backfill tolerance the read path already has (risks R3). */
  integrations?: IntegrationConnectionsMirror;
  /** IR5 audit seam: integration.connected / integration.revoked on the
   *  re-homed lifecycle. Absent = no emission (best-effort everywhere). */
  events?: AuditEmitter;
  /** Provider-key custody client (config-worker service binding). Absent when
   * CONFIG_WORKER is unbound — provider routes then 503. */
  providerKeys?: ProviderKeyClient;
  /** Best-effort org-setting read (session model preference, DX-Q6 on the
   * session path). Absent or failing = sole-or-default selection. */
  orgSettings?: OrgSettingReader;
  /** Provider verification pings (AG12 §10.3); stubbed in tests. */
  verifier?: ProviderVerifier;
  /** Sandbox adapters keyed by provider (AG5); stubbed in tests. */
  sandboxes?: SandboxFactory;
  /** DX7: the anthropic-managed executor factory (fixture-stubbed in tests). */
  managedAgents?: (apiKey: string, config: Record<string, unknown>) => ManagedAgentsAdapter | null;
  /** Agent-session token mint over the identity binding (AG6 §3.2). */
  sessionTokens?: SessionTokenMinter;
  /** feature.agents entitlement gate (AG10 §8); absent = open (D3). */
  entitlement?: (orgId: string, requestId: string) => Promise<AgentsEntitlementGate>;
  /** Public platform API base URL the in-sandbox bootstrap dials home to
   * (heartbeat/events/token). Derived from ENVIRONMENT in production. */
  apiBaseUrl?: string;
  /** Usage emission (AG10 §8); absent = no metering. Fire-and-forget. */
  usage?: UsageRecorder;
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
    // IR5: identity rows + audit ride the same executor as the agents repo.
    integrations: createIntegrationsRepository(executor),
    events: createEventsRepository(executor),
    ...(env.CONFIG_WORKER
      ? {
          providerKeys: createProviderKeyClient(env.CONFIG_WORKER),
          orgSettings: createOrgSettingReader(env.CONFIG_WORKER),
        }
      : {}),
    verifier: createProviderVerifier(),
    ...(env.IDENTITY_WORKER ? { sessionTokens: createSessionTokenMinter(env.IDENTITY_WORKER) } : {}),
    ...(env.BILLING_WORKER
      ? {
          entitlement: async (orgId: string, requestId: string) =>
            decideAgentsFeature(await checkBillingEntitlement(env.BILLING_WORKER!, orgId, "feature.agents", requestId)),
        }
      : {}),
    ...(env.METERING_WORKER ? { usage: createUsageRecorder(env.METERING_WORKER) } : {}),
    // The same host the console + CLI use (custom hostnames route here too);
    // workers.dev is always live, so the bootstrap needs no per-env DNS.
    apiBaseUrl: `https://api-edge-${env.ENVIRONMENT}.oruncloud.workers.dev`,
    managedAgents(apiKey, config) {
      return createManagedAgentsAdapter({
        apiKey,
        ...(typeof config.baseUrl === "string" && config.baseUrl ? { apiUrl: config.baseUrl } : {}),
      });
    },
    sandboxes(provider, apiKey, config) {
      if (provider !== "daytona") return null;
      return createDaytonaProvider({
        apiKey,
        ...(typeof config.apiUrl === "string" && config.apiUrl ? { apiUrl: config.apiUrl } : {}),
        ...(typeof config.proxyUrl === "string" && config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
        ...(typeof config.target === "string" && config.target ? { target: config.target } : {}),
      });
    },
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
