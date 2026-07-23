// OpenAI adapter (saas-integration-registry IR5) — re-homed AI-provider
// identity, connect kind "apikey". Connect-only: custody stays under the
// reserved agents/providers/* namespace; model behavior stays on the agents
// plane. See ./anthropic.ts for the family posture.

import type { FetchLike } from "../github-app.js";
import { apiKeyBaseUrl, pingApiKey } from "./apikey.js";
import type { IntegrationProvider } from "./types.js";

const OPENAI_API = "https://api.openai.com/v1";

export function createOpenaiProvider(fetchImpl?: FetchLike): IntegrationProvider {
  return {
    id: "openai",
    displayName: "OpenAI",
    connectKind: "apikey",
    capabilities: ["connect"],

    // GET /v1/models — read-only key-validity probe (OpenAI-compatible).
    async verifyApiKey(apiKey, config) {
      return pingApiKey(
        `${apiKeyBaseUrl(config, OPENAI_API)}/models`,
        { authorization: `Bearer ${apiKey}` },
        fetchImpl,
      );
    },
  };
}
