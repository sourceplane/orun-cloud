// custody — the workspace Anthropic key, resolved at turn time through the
// AG5/AG12 path (saas-agents-native lock 6): the chat loop burns the
// workspace's OWN key; config-worker stays the only decrypt path; the key is
// never stored in DO state and never appears in chat content. The connection
// is discovered through the PUBLIC providers surface with the owner's
// credential (the agent is a client, design §5.1) — only the custody resolve
// itself rides the narrow CONFIG_WORKER seam.

export interface ProviderConnectionLite {
  provider: string;
  name: string;
  status: string;
}

/** pickAnthropic mirrors the provisioning spawn gate's sole-or-default rule. */
export function pickAnthropic(connections: ProviderConnectionLite[]): ProviderConnectionLite | null {
  const rows = connections.filter((c) => c.provider === "anthropic");
  if (rows.length === 0) return null;
  const chosen = rows.length === 1 ? rows[0]! : (rows.find((c) => c.name === "default") ?? null);
  if (!chosen || chosen.status !== "verified") return null;
  return chosen;
}

/** anthropicSecretRef mirrors @saas/db/agents providerSecretRef — the
 * deterministic custody key (the db package is control-plane; the convention
 * is the contract this worker depends on). */
export function anthropicSecretRef(name: string): string {
  return `agents/providers/anthropic/${name}/API_KEY`;
}

export interface CustodyDeps {
  /** List the workspace's provider connections via the PUBLIC surface with
   * the owner's credential (SDK-backed in production, faked in tests). */
  listConnections(orgId: string): Promise<ProviderConnectionLite[]>;
  /** Resolve a custody secret through config-worker (the narrow seam). */
  resolveKey(orgId: string, secretRef: string): Promise<string | null>;
}

/** resolveAnthropicKey: connection discovery (public surface) + custody
 * resolve (config-worker). Null = honest error turn upstream. */
export async function resolveAnthropicKey(deps: CustodyDeps, orgId: string): Promise<string | null> {
  try {
    const connections = await deps.listConnections(orgId);
    const chosen = pickAnthropic(connections);
    if (!chosen) return null;
    return await deps.resolveKey(orgId, anthropicSecretRef(chosen.name));
  } catch {
    return null;
  }
}

/** The slice of a service binding the resolver needs (structural, so the
 * module loads under plain Node for the jest suite). */
export interface FetcherLike {
  fetch(input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>;
}

/** createConfigResolver — the CONFIG_WORKER custody client (the agents-worker
 * pattern, verbatim posture: never encrypt, decrypt, or persist here). */
export function createConfigResolver(configWorker: FetcherLike, actorId: string) {
  return async (orgId: string, secretRef: string): Promise<string | null> => {
    try {
      const res = await configWorker.fetch("http://config-worker/v1/internal/config/provider-keys/resolve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-actor-subject-id": actorId,
          "x-actor-subject-type": "service",
        },
        body: JSON.stringify({ orgId, key: secretRef }),
      });
      if (!res.ok) return null;
      const parsed = (await res.json()) as { data?: { value?: string } };
      return typeof parsed.data?.value === "string" ? parsed.data.value : null;
    } catch {
      return null;
    }
  };
}
