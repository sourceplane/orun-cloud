// Provider verification pings (saas-agents AG12, design §10.3): cheap,
// read-only calls that prove a connected key works BEFORE a session rides it.
// Behind a seam so tests stub the vendor; failures return a redacted,
// human-readable reason — never key material, never a response body echo.

export interface VerifyResult {
  ok: boolean;
  /** Redacted failure reason ("401 from provider"), absent on success. */
  reason?: string;
}

export interface ProviderVerifier {
  verify(provider: string, apiKey: string, config: Record<string, unknown>): Promise<VerifyResult>;
}

const DEFAULT_DAYTONA_API = "https://app.daytona.io/api";
const ANTHROPIC_API = "https://api.anthropic.com";

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

/** The production verifier: real vendor pings. */
export function createProviderVerifier(): ProviderVerifier {
  return {
    async verify(provider, apiKey, config) {
      switch (provider) {
        case "daytona": {
          const base = typeof config.apiUrl === "string" && config.apiUrl ? config.apiUrl : DEFAULT_DAYTONA_API;
          // List sandboxes — read-only, cheap, and exercises org-scoped auth.
          return ping(`${base.replace(/\/$/, "")}/sandbox`, {
            authorization: `Bearer ${apiKey}`,
          });
        }
        case "anthropic":
          // GET /v1/models — the canonical key-validity probe; no tokens spent.
          return ping(`${ANTHROPIC_API}/v1/models`, {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          });
        default:
          return { ok: false, reason: "provider unsupported" };
      }
    },
  };
}
