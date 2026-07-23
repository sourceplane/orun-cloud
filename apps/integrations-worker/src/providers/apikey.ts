// Shared apikey-kind verification helpers (saas-integration-registry IR5).
//
// The AI/compute adapters mirror the verification probes agents-worker's
// verifier runs (apps/agents-worker/src/verifiers.ts): a cheap read-only GET
// that proves the pasted key without spending tokens. Failures are REDACTED to
// a status code — the response body may echo the key or account details.

import type { FetchLike } from "../github-app.js";
import type { ApiKeyVerifyResult } from "./types.js";

/** A workspace may point an OpenAI-compatible provider at its own gateway via
 *  config.baseUrl; fall back to the vendor default. Trailing slash trimmed so
 *  `${base}/models` is well-formed. Mirrors agents-worker's verifier. */
export function apiKeyBaseUrl(config: Record<string, unknown>, fallback: string): string {
  const raw =
    typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim() : fallback;
  return raw.replace(/\/+$/, "");
}

/** Read-only key-validity ping; redacts every failure to a status code. */
export async function pingApiKey(
  url: string,
  headers: Record<string, string>,
  fetchImpl?: FetchLike,
): Promise<ApiKeyVerifyResult> {
  const doFetch = fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { method: "GET", headers });
  } catch {
    return { ok: false, reason: "provider unreachable" };
  }
  if (res.ok) return { ok: true };
  return { ok: false, reason: `${res.status} from provider` };
}
