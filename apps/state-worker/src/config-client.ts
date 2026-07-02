// Internal call to config-worker's lease-bound secrets resolve (SM3).
//
// Reachable only over the CONFIG_WORKER service binding — /v1/internal/* is
// never forwarded by api-edge. state-worker calls this AFTER it has (a) run
// bearer authz (`state.run.write`) and (b) verified the caller holds a LIVE
// job lease (lease.ts), so the verified actor headers it forwards are the
// authorization config-worker's Layer-1/Layer-2 checks act on. The response
// carries plaintext values — the ONLY machine route that does — so the caller
// relays it verbatim and never logs bodies.

/** One requested key, optionally pinned to a version (`…/KEY@3`). */
export interface InternalResolveKey {
  key: string;
  version?: number;
}

/** The internal resolve request body (raw UUIDs — internal-seam convention). */
export interface InternalResolveSecretsRequest {
  orgId: string;
  projectId: string;
  environmentId: string;
  /** Environment slug — the Layer-2 `env` fact. */
  environment: string;
  keys: InternalResolveKey[];
  /** Server-derived platform fact: "ci-oidc" | "local-cli" | "service". */
  platform: string;
  trigger: {
    branch: string | null;
    declared: boolean;
  };
  /** Run/job provenance stamped onto secret.accessed events. */
  runId: string;
  jobId: string;
}

/**
 * POST /v1/internal/config/secrets/resolve over the service binding, forwarding
 * the VERIFIED actor. Returns the raw Response so the caller can relay the
 * body (success or typed denial) verbatim. Throws only on transport failure.
 */
export async function resolveSecretsInternal(
  configWorker: Fetcher,
  actor: { subjectId: string; subjectType: string },
  body: InternalResolveSecretsRequest,
  requestId: string,
): Promise<Response> {
  return configWorker.fetch("http://config-worker/v1/internal/config/secrets/resolve", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": requestId,
      "x-actor-subject-id": actor.subjectId,
      "x-actor-subject-type": actor.subjectType,
    },
    body: JSON.stringify(body),
  });
}
