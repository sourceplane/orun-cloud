// Provider verification (saas-agents AG12, design §10.3): prove a connected key
// works BEFORE a session rides it. Behind a seam so tests stub the vendor;
// failures return a redacted, human-readable reason — never key material, never
// a response body echo.
//
// Daytona verification exercises CREATE's own code path (AG12 fix): a read-only
// `GET /sandbox` list ping proves auth but NOT that the account will accept a
// create BODY — the target/autoStop/autoDelete/snapshot fields that 400 a real
// spawn while the list ping passes ("verified" that never boots). Verify now
// builds a sandbox exactly as provisioning would and immediately reclaims it, so
// "verified" predicts spawn. Anthropic stays a cheap read-only `GET /v1/models`.

import type { SandboxSpec } from "@saas/contracts/agents";
import { createDaytonaProvider } from "./providers/daytona.js";

export interface VerifyResult {
  ok: boolean;
  /** Redacted failure reason ("401 from provider"), absent on success. */
  reason?: string;
}

export interface ProviderVerifier {
  verify(provider: string, apiKey: string, config: Record<string, unknown>): Promise<VerifyResult>;
}

const ANTHROPIC_API = "https://api.anthropic.com";
const OPENAI_API = "https://api.openai.com/v1";
const OPENROUTER_API = "https://openrouter.ai/api/v1";

/** A workspace may point an OpenAI-compatible provider at its own gateway via
 * config.baseUrl; fall back to the vendor default. Trailing slash trimmed so
 * `${base}/models` is well-formed. */
function baseUrlFrom(config: Record<string, unknown>, fallback: string): string {
  const raw = typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim() : fallback;
  return raw.replace(/\/+$/, "");
}

async function ping(url: string, headers: Record<string, string>): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers });
  } catch {
    return { ok: false, reason: "provider unreachable" };
  }
  if (res.ok) return { ok: true };
  // Redact: status code only; the body may echo the key or account details.
  return { ok: false, reason: `${res.status} from provider` };
}

/**
 * Daytona verify on the CREATE path: build the sandbox exactly as
 * handleProvisionSession would (same connection config → apiUrl/target/snapshot/
 * ttl → the create body the account may reject), then immediately reclaim it.
 * The adapter already redacts every failure to a status code, so a create-time
 * reject surfaces here as the SAME reason a spawn would fail with. Best-effort
 * destroy with the provider's autoStop/autoDelete as the reclaim backstop — a
 * probe box is never left behind (over-destroy on ambiguity, the spawn posture).
 */
async function verifyDaytonaCreate(apiKey: string, config: Record<string, unknown>): Promise<VerifyResult> {
  const provider = createDaytonaProvider({
    apiKey,
    ...(typeof config.apiUrl === "string" && config.apiUrl ? { apiUrl: config.apiUrl } : {}),
    ...(typeof config.target === "string" && config.target ? { target: config.target } : {}),
  });
  const spec: SandboxSpec = {
    ...(typeof config.snapshot === "string" && config.snapshot ? { baseSnapshot: config.snapshot } : {}),
    ttlSeconds: typeof config.ttlSeconds === "number" && config.ttlSeconds > 0 ? config.ttlSeconds : 3600,
    egressAllow: [],
  };
  let ref;
  try {
    ref = await provider.create(spec);
  } catch (e) {
    // The adapter's message is already status-only ("daytona POST sandbox: 400
    // from provider") — no key, no account body. Pass it through.
    return { ok: false, reason: e instanceof Error ? e.message : "provider unreachable" };
  }
  await provider.destroy(ref).catch(() => {});
  return { ok: true };
}

/** The production verifier: real vendor probes. */
export function createProviderVerifier(): ProviderVerifier {
  return {
    async verify(provider, apiKey, config) {
      switch (provider) {
        case "daytona":
          return verifyDaytonaCreate(apiKey, config);
        case "anthropic":
          // GET /v1/models — the canonical key-validity probe; no tokens spent.
          return ping(`${baseUrlFrom(config, ANTHROPIC_API + "/v1")}/models`, {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          });
        case "openai":
          // GET /v1/models — read-only key-validity probe (OpenAI-compatible).
          return ping(`${baseUrlFrom(config, OPENAI_API)}/models`, {
            authorization: `Bearer ${apiKey}`,
          });
        case "openrouter":
          // GET /key — returns the key's own limits/credits; a cheap, no-token
          // validity probe that also works when /models is served unauthenticated.
          return ping(`${baseUrlFrom(config, OPENROUTER_API)}/key`, {
            authorization: `Bearer ${apiKey}`,
          });
        default:
          return { ok: false, reason: "provider unsupported" };
      }
    },
  };
}
