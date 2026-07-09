// Service-binding client for identity-worker's agent-session token mint
// (saas-agents AG6 §3.2). agents-worker never signs tokens itself — one
// signing key, one bearer path, both owned by identity-worker. The lease gate
// stays HERE (agents-worker owns the session row); identity only turns an
// authorized (principal, org, session) triple into a signed short-TTL bearer.

export interface MintedSessionToken {
  token: string;
  expiresAt: string;
}

export interface SessionTokenMinter {
  mint(principalId: string, orgId: string, sessionId: string, requestId: string): Promise<MintedSessionToken | null>;
}

export function createSessionTokenMinter(identityWorker: Fetcher): SessionTokenMinter {
  return {
    async mint(principalId, orgId, sessionId, requestId) {
      let res: Response;
      try {
        res = await identityWorker.fetch("http://identity-worker/v1/internal/identity/agent-session-token", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": requestId },
          body: JSON.stringify({ principalId, orgId, sessionId }),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      try {
        const parsed = (await res.json()) as { data?: { token?: string; expiresAt?: string } };
        if (typeof parsed.data?.token !== "string" || typeof parsed.data?.expiresAt !== "string") return null;
        return { token: parsed.data.token, expiresAt: parsed.data.expiresAt };
      } catch {
        return null;
      }
    },
  };
}
