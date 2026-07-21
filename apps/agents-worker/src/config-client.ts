// Service-binding client for config-worker's provider-key custody
// (saas-agents AG12, design §10.2). agents-worker never encrypts, decrypts, or
// persists key material itself — config-worker stays the only decrypt path.

import type { ActorContext } from "./router.js";

export interface ProviderKeyClient {
  store(orgId: string, key: string, value: string, actor: ActorContext, requestId: string): Promise<boolean>;
  resolve(orgId: string, key: string, actor: ActorContext, requestId: string): Promise<string | null>;
  /** Idempotent revoke of a connection's custody secret (disconnect teardown /
   * orphan cleanup before a fresh connect reuses the same ref). Best-effort:
   * resolves true when the seam confirms the ref is clean (revoked or absent). */
  revoke(orgId: string, key: string, actor: ActorContext, requestId: string): Promise<boolean>;
}

export function createProviderKeyClient(configWorker: Fetcher): ProviderKeyClient {
  async function post(path: string, body: unknown, actor: ActorContext, requestId: string): Promise<Response | null> {
    try {
      return await configWorker.fetch(`http://config-worker${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-request-id": requestId,
          "x-actor-subject-id": actor.subjectId,
          "x-actor-subject-type": actor.subjectType,
        },
        body: JSON.stringify(body),
      });
    } catch {
      return null;
    }
  }

  return {
    async store(orgId, key, value, actor, requestId) {
      const res = await post("/v1/internal/config/provider-keys/store", { orgId, key, value }, actor, requestId);
      return !!res && res.ok;
    },
    async resolve(orgId, key, actor, requestId) {
      const res = await post("/v1/internal/config/provider-keys/resolve", { orgId, key }, actor, requestId);
      if (!res || !res.ok) return null;
      try {
        const parsed = (await res.json()) as { data?: { value?: string } };
        return typeof parsed.data?.value === "string" ? parsed.data.value : null;
      } catch {
        return null;
      }
    },
    async revoke(orgId, key, actor, requestId) {
      const res = await post("/v1/internal/config/provider-keys/revoke", { orgId, key }, actor, requestId);
      return !!res && res.ok;
    },
  };
}
