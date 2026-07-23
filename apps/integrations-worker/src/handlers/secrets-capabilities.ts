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
import { createScopeTemplatesRepository } from "@saas/db/integrations";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import type { Uuid } from "@saas/db/ids";
import { asUuid } from "@saas/db/ids";
import { successResponse } from "../http.js";
import { getConfiguredProvider, getDormantProvider } from "../providers/registry.js";
import { listIntegrationManifests } from "../providers/manifests/index.js";
import { authorizeIntegration } from "./connections.js";
import { mergeActiveTemplates } from "./scope-templates.js";

export interface SecretsCapabilitiesDeps {
  executor?: SqlExecutor;
}

export async function handleListSecretsCapabilities(
  _request: Request,
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  deps?: SecretsCapabilitiesDeps,
): Promise<Response> {
  const denied = await authorizeIntegration(
    env,
    actor,
    orgId,
    INTEGRATION_POLICY_ACTIONS.READ,
    requestId,
  );
  if (denied) return denied;

  // SP4: the served catalog = code-declared templates + this org's ACTIVE
  // custom templates. Fail-soft — a template-store read failure serves the
  // declared catalog rather than failing the whole capability read.
  const executor = deps?.executor ?? (env.PLATFORM_DB ? createSqlExecutor(env.PLATFORM_DB) : null);
  const templatesRepo = executor ? createScopeTemplatesRepository(executor) : null;

  // IR0: this read is a PROJECTION of the Integration Registry — the provider
  // iteration order and set come from the manifests, the capability payload
  // still comes from the adapters' `secrets` objects. Wire shape unchanged.
  const capabilities: ProviderSecretsCapability[] = [];
  for (const id of listIntegrationManifests().map((m) => m.id)) {
    // A configured provider (env secrets present) is the live case; fall back
    // to the dormant registry so a reserved provider's declaration still lists.
    const provider = getConfiguredProvider(env, id)?.provider ?? getDormantProvider(id);
    if (!provider?.secrets) continue;
    const s = provider.secrets;
    let scopeTemplates = s.scopeTemplates();
    if (templatesRepo) {
      const customs = await templatesRepo.listScopeTemplates(asUuid(orgId) as Uuid, provider.id);
      if (customs.ok && customs.value.length > 0) {
        scopeTemplates = mergeActiveTemplates(scopeTemplates, customs.value);
      }
    }
    capabilities.push({
      provider: provider.id as IntegrationProviderId,
      scopeTemplates,
      supportedModes: s.supportedModes,
      deliveryTargets: s.deliveryTargets(),
      authoring: s.authoring,
    });
  }

  const payload: ProviderSecretsCapabilitiesResponse = { capabilities };
  return successResponse(payload, requestId);
}
