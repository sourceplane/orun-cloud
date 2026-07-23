// OpenRouter adapter (saas-integration-registry IR5) — re-homed AI-provider
// identity, connect kind "apikey". Connect-only: custody stays under the
// reserved agents/providers/* namespace; model behavior stays on the agents
// plane. See ./anthropic.ts for the family posture.

import type { FetchLike } from "../github-app.js";
import { apiKeyBaseUrl, pingApiKey } from "./apikey.js";
import type { IntegrationProvider } from "./types.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1";

export function createOpenrouterProvider(fetchImpl?: FetchLike): IntegrationProvider {
  return {
    id: "openrouter",
    displayName: "OpenRouter",
    connectKind: "apikey",
    capabilities: ["connect"],

    // GET /key — returns the key's own limits/credits; a cheap, no-token
    // validity probe that also works when /models is served unauthenticated.
    async verifyApiKey(apiKey, config) {
      return pingApiKey(
        `${apiKeyBaseUrl(config, OPENROUTER_API)}/key`,
        { authorization: `Bearer ${apiKey}` },
        fetchImpl,
      );
    },
  };
}
