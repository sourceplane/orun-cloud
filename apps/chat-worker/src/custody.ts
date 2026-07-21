// custody — the workspace's model key for the Workspace Agent, resolved at
// turn time through the AG5/AG12 path (saas-agents-native lock 6): the chat
// loop burns the workspace's OWN key; config-worker stays the only decrypt
// path; the key is never stored in DO state and never appears in chat
// content. The connection is discovered through the PUBLIC providers surface
// with the owner's credential (the agent is a client, design §5.1) — only the
// custody resolve itself rides the narrow CONFIG_WORKER seam.
//
// DX-Q6: the model provider is no longer hard-wired to Anthropic. Dispatch
// uses whichever verified model connection the workspace picks
// (anthropic / openai / openrouter) — the one the `agents.chat.connection`
// setting names, else the sole one, else the one named `default`.

export interface ProviderConnectionLite {
  /** Public id (`apc_…`) — how the dispatch-model setting names a choice. */
  id?: string;
  provider: string;
  name: string;
  status: string;
  /** Non-secret config (baseUrl / defaultModel for OpenAI-compatible). */
  config?: Record<string, unknown>;
}

/** Providers that supply a chat/model key (Daytona is compute, excluded). */
const MODEL_PROVIDERS = new Set(["anthropic", "openai", "openrouter"]);

/**
 * pickModelConnection — the dispatch model selection rule:
 *   1. the connection the `agents.chat.connection` setting names, if present
 *      and verified (explicit choice from Settings › AI providers);
 *   2. else the sole verified model connection;
 *   3. else the one named `default`;
 *   4. else null (ambiguous — the settings selector resolves it).
 */
export function pickModelConnection(
  connections: ProviderConnectionLite[],
  preferredId?: string | null,
): ProviderConnectionLite | null {
  const rows = connections.filter((c) => MODEL_PROVIDERS.has(c.provider) && c.status === "verified");
  if (rows.length === 0) return null;
  if (preferredId) {
    const chosen = rows.find((c) => c.id === preferredId);
    if (chosen) return chosen;
  }
  if (rows.length === 1) return rows[0]!;
  return rows.find((c) => c.name === "default") ?? null;
}

/** providerSecretRef mirrors @saas/db/agents providerSecretRef — the
 * deterministic custody key (the db package is control-plane; the convention
 * is the contract this worker depends on). */
export function providerSecretRef(provider: string, name: string): string {
  return `agents/providers/${provider}/${name}/API_KEY`;
}

export interface CustodyDeps {
  /** List the workspace's provider connections via the PUBLIC surface with
   * the owner's credential (SDK-backed in production, faked in tests). */
  listConnections(orgId: string): Promise<ProviderConnectionLite[]>;
  /** Resolve a custody secret through config-worker (the narrow seam). */
  resolveKey(orgId: string, secretRef: string): Promise<string | null>;
}

export interface ResolvedModel {
  provider: string;
  /** Non-secret connection config (baseUrl / defaultModel). */
  config: Record<string, unknown>;
  key: string;
}

/** resolveDispatchModel: connection discovery (public surface) + custody
 * resolve (config-worker). Null = honest error turn upstream. `preferredId`
 * is the `agents.chat.connection` setting, when set. */
export async function resolveDispatchModel(
  deps: CustodyDeps,
  orgId: string,
  preferredId?: string | null,
): Promise<ResolvedModel | null> {
  try {
    const connections = await deps.listConnections(orgId);
    const chosen = pickModelConnection(connections, preferredId ?? null);
    if (!chosen) return null;
    const key = await deps.resolveKey(orgId, providerSecretRef(chosen.provider, chosen.name));
    if (!key) return null;
    return { provider: chosen.provider, config: chosen.config ?? {}, key };
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

/** The dispatch-model preference setting key (org scope). Set from
 * Settings › AI providers; read best-effort at turn time. */
export const DISPATCH_MODEL_SETTING_KEY = "agents.chat.connection";
