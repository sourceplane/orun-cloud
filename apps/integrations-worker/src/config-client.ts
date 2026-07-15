// config-worker client (brokered-orphan-safety, Feature 2).
//
// The reverse of the config→integrations mint edge: the connection revoke guard
// asks config-worker which ACTIVE brokered secrets still point at a connection
// before it revokes. Metadata only — never a secret value.

import type { BrokeredSecretRef } from "./revoke-guard.js";

export type BrokeredRefsResult =
  | { ok: true; refs: BrokeredSecretRef[] }
  | { ok: false };

interface WireSecret {
  id: string;
  secretKey: string;
  scopeKind?: string;
  environmentId?: string | null;
}

/** Human scope label for revoke-guard copy: "environment" carries the env id. */
function scopeLabel(s: WireSecret): string {
  if (s.scopeKind === "environment") {
    return s.environmentId ? `environment (${s.environmentId})` : "environment";
  }
  return s.scopeKind ?? "workspace";
}

export async function fetchBrokeredSecretsByConnection(
  configWorker: Fetcher,
  connectionPublicId: string,
  requestId: string,
): Promise<BrokeredRefsResult> {
  let response: Response;
  try {
    response = await configWorker.fetch(
      "http://config-worker/v1/internal/config/secrets/by-connection",
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-request-id": requestId },
        body: JSON.stringify({ connectionId: connectionPublicId }),
      },
    );
  } catch {
    return { ok: false };
  }
  if (response.status !== 200) return { ok: false };
  try {
    const parsed = (await response.json()) as { data?: { secrets?: WireSecret[] } };
    const secrets = parsed.data?.secrets ?? [];
    return {
      ok: true,
      refs: secrets.map((s) => ({ id: s.id, secretKey: s.secretKey, scope: scopeLabel(s) })),
    };
  } catch {
    return { ok: false };
  }
}
