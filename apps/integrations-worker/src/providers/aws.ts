// AWS adapter (saas-integration-hub IH10, dormant) — the credential-broker
// archetype's next entrant, compiled against the seam but with NO live path.
//
// This is the pluggability proof for the broker capability: adding a provider
// whose short-lived credentials come from STS `AssumeRole` (a role ARN as the
// parent, a scoped session as the mint) required ZERO changes to the broker
// handler, the ledger, custody, the sweeps, or the console — only this file
// and its reserved contract id. The Stripe-after-Polar discipline, now
// per-capability: the shape is real, the wiring is proven, the switch is off.
//
// connectKind "token": the customer would paste a role ARN + external id once
// (the AssumeRole trust anchor), exactly as Cloudflare pastes a parent token.
// Until a connect milestone lands, mintCredential answers `not_implemented`
// and the registry never resolves this id to a configured adapter.

import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import type {
  CredentialBrokerCapability,
  IntegrationProvider,
} from "./types.js";

/**
 * STS `AssumeRole`-shaped scope templates. Each names an effective breadth
 * honestly (risks R5): AWS scopes a session by the assumed role's policy plus
 * an optional inline session policy, so a template documents which role it
 * targets rather than pretending to mint arbitrary permissions. The hard TTL
 * ceiling mirrors STS's own 15-minute floor / 1-hour default for role chaining.
 */
export const AWS_SCOPE_TEMPLATES: readonly IntegrationScopeTemplate[] = [
  {
    id: "deploy-session",
    provider: "aws",
    version: 1,
    displayName: "Deploy session",
    description:
      "A short-lived STS session assuming the connection's deploy role. Effective breadth is that role's policy; params may pass an inline session policy to narrow it further.",
    params: ["roleSessionName", "sessionPolicyArn"],
    maxTtlSeconds: 3600,
  },
  {
    id: "readonly-session",
    provider: "aws",
    version: 1,
    displayName: "Read-only session",
    description:
      "A short-lived STS session assuming the connection's read-only role. Effective breadth is that role's policy.",
    params: ["roleSessionName"],
    maxTtlSeconds: 3600,
  },
];

/**
 * A dormant broker adapter for AWS. It publishes templates (so a future
 * console + connect milestone can render "what can be minted") but refuses
 * every mint with `not_implemented` — the typed dormancy signal the broker
 * handler already maps to a 412, exactly as it did for the pre-live providers.
 */
export function createAwsProvider(): IntegrationProvider {
  const broker: CredentialBrokerCapability = {
    scopeTemplates() {
      return AWS_SCOPE_TEMPLATES;
    },
    async mintCredential() {
      // No STS call is wired — dormant until a connect milestone.
      return { ok: false, reason: "not_implemented" };
    },
    async revokeCredential() {
      // STS sessions are TTL-only (no provider-side revoke); the ledger TTL is
      // the backstop, same posture as Supabase access tokens.
      return false;
    },
  };

  return {
    id: "aws",
    displayName: "AWS",
    connectKind: "token",
    capabilities: ["connect", "credential-broker"],

    broker,
  };
}
