// GET /internal/providers/secrets-capability?provider={id}
// (saas-secrets-platform SP0).
//
// Projects a provider's secret-source DESCRIBE capability — scope templates,
// supported modes, delivery targets, authoring — so the secrets substrate
// (config-worker create gate; the console create surface) derives what it used
// to hardcode (BROKER_CAPABLE_PROVIDERS / ALLOWED_ROTATION_PROVIDERS /
// SCOPE_TEMPLATE_CATALOG). Pure metadata: never a credential, never a value.
//
// Reachable over the config→integrations service binding AND (later, SP0c) the
// console via api-edge — it carries no secrets, so it is not gated to a single
// caller. Returns 404 for a provider that is not configured for this
// environment or does not declare the `secrets` capability.

import type { Env } from "../env.js";
import type { ProviderSecretsCapabilityResponse } from "@saas/contracts/integrations";
import { errorResponse, successResponse } from "../http.js";
import { getConfiguredProvider, getDormantProvider } from "../providers/registry.js";
import type { IntegrationProviderId } from "@saas/contracts/integrations";

export async function handleInternalSecretsCapability(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const providerId = new URL(request.url).searchParams.get("provider");
  if (!providerId) {
    return errorResponse("validation_failed", "provider query param is required", 422, requestId, {
      reason: "params_invalid",
    });
  }

  // A configured provider (env secrets present) is the live case; fall back to
  // the dormant registry so the capability of a reserved provider is still
  // describable (IH10 proof) without a connect milestone.
  const provider =
    getConfiguredProvider(env, providerId)?.provider ?? getDormantProvider(providerId);
  if (!provider || !provider.secrets) {
    return errorResponse("not_found", "No secret-source capability for this provider", 404, requestId, {
      reason: "capability_not_supported",
    });
  }

  const s = provider.secrets;
  const payload: ProviderSecretsCapabilityResponse = {
    capability: {
      provider: provider.id as IntegrationProviderId,
      scopeTemplates: s.scopeTemplates(),
      supportedModes: s.supportedModes,
      deliveryTargets: s.deliveryTargets(),
      authoring: s.authoring,
    },
  };
  return successResponse(payload, requestId);
}

/** Path this handler serves (query param carries the provider id). */
export const SECRETS_CAPABILITY_PATH = "/internal/providers/secrets-capability";
