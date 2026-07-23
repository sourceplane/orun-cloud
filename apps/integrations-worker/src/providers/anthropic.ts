// Anthropic adapter (saas-integration-registry IR5) — the first re-homed
// AI-provider identity. Connect kind "apikey": the customer pastes a model
// key once; custody stays in the config substrate under the reserved
// agents/providers/* namespace and session/dispatch behavior stays on the
// agents plane. This adapter is CONNECT-ONLY metadata + the verification
// probe — it never holds, resolves, or proxies the key.

import type { FetchLike } from "../github-app.js";
import { apiKeyBaseUrl, pingApiKey } from "./apikey.js";
import type { IntegrationProvider } from "./types.js";

const ANTHROPIC_API = "https://api.anthropic.com/v1";

export function createAnthropicProvider(fetchImpl?: FetchLike): IntegrationProvider {
  return {
    id: "anthropic",
    displayName: "Anthropic",
    connectKind: "apikey",
    capabilities: ["connect"],

    // GET /v1/models — the canonical key-validity probe; no tokens spent.
    // Mirrors agents-worker's verifier exactly (same endpoint, same headers).
    async verifyApiKey(apiKey, config) {
      return pingApiKey(
        `${apiKeyBaseUrl(config, ANTHROPIC_API)}/models`,
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        fetchImpl,
      );
    },
  };
}
