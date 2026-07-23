// GET /v1/organizations/:orgId/integrations/secrets-capabilities
// (saas-secrets-platform SP0c, design addendum SP-A1).
//
// The org-facing BULK read of every provider's secret-source DESCRIBE
// capability, consumed by the console so its create surfaces and the Secrets
// lens derive what they used to hardcode (BROKER_CAPABLE_PROVIDERS /
// SCOPE_TEMPLATE_CATALOG). One response for all providers → one console cache
// entry. Pure metadata: never a credential, never a value.
//
// The per-provider internal read (internal-secrets-capability.ts) stays the
// config-worker service-binding seam; this route rides the api-edge
// integrations facade and is actor-authed like every org surface. Dormant
// providers are included when they declare the capability (IH10 posture), so
// a reserved provider is describable before its connect milestone.

import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import type {
  IntegrationProviderId,
  ProviderSecretsCapabilitiesResponse,
  ProviderSecretsCapability,
} from "@saas/contracts/integrations";
import { INTEGRATION_POLICY_ACTIONS } from "@saas/contracts/integrations";
import { successResponse } from "../http.js";
import {
  DORMANT_PROVIDER_IDS,
  getConfiguredProvider,
  getDormantProvider,
  KNOWN_PROVIDER_IDS,
} from "../providers/registry.js";
import { authorizeIntegration } from "./connections.js";

export async function handleListSecretsCapabilities(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  const capabilities: ProviderSecretsCapability[] = [];
  for (const id of [...KNOWN_PROVIDER_IDS, ...DORMANT_PROVIDER_IDS]) {
    // A configured provider (env secrets present) is the live case; fall back
    // to the dormant registry so a reserved provider's declaration still lists.
    const provider = getConfiguredProvider(env, id)?.provider ?? getDormantProvider(id);
    if (!provider?.secrets) continue;
    const s = provider.secrets;
    capabilities.push({
      provider: provider.id as IntegrationProviderId,
      scopeTemplates: s.scopeTemplates(),
      supportedModes: s.supportedModes,
      deliveryTargets: s.deliveryTargets(),
      authoring: s.authoring,
    });
  }

  const payload: ProviderSecretsCapabilitiesResponse = { capabilities };
  return successResponse(payload, requestId);
}
