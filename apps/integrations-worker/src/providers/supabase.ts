// Supabase adapter (saas-integration-hub IH6) — the credential-broker
// archetype, OAuth-connected, live. connectKind "oauth": PKCE (S256) against
// the Management API — our published OAuth app (risks D4), signed state,
// keystone `supabase_org_id ↔ org_id`. Mints derive short-lived Management
// API access tokens from the refresh token via `grant_type=refresh_token`.
//
// Custody rule: the refresh token obtained at connect lives ONLY as a
// provider_credentials envelope; short-lived access tokens are derived on
// demand and never handed out durable. Supabase ROTATES the refresh token on
// every use — the adapter surfaces the rotated token via
// `rotatedParentCredential` so the broker handler re-envelopes custody.

import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import type { FetchLike } from "../github-app.js";
import type {
  CredentialBrokerCapability,
  IntegrationProvider,
  MintCredentialOutcome,
  SupabaseOauthCredentials,
} from "./types.js";

const API_BASE = "https://api.supabase.com";

export const SUPABASE_MAX_TTL_SECONDS = 60 * 60;

/** Best-effort project-list cap — connect facts, not an inventory sync. */
export const SUPABASE_MAX_PROJECTS = 50;

/**
 * The v1 template catalog (design §5.3). Where the Management API cannot
 * narrow issuance to a template's declared intent, the description states
 * the effective breadth honestly (risks R5) — the ledger still binds usage
 * to the declared purpose.
 */
export const SUPABASE_SCOPE_TEMPLATES: readonly IntegrationScopeTemplate[] = [
  {
    id: "management-access",
    provider: "supabase",
    version: 1,
    displayName: "Management API access",
    description:
      "A short-lived Management-API access token for the connected Supabase organization. Breadth is the OAuth grant (org-wide); TTL is provider-fixed and reported honestly in the ledger.",
    params: [],
    maxTtlSeconds: SUPABASE_MAX_TTL_SECONDS,
  },
  {
    id: "db-migrate",
    provider: "supabase",
    version: 1,
    displayName: "Run database migrations",
    description:
      "The credential bundle the migration runner needs for one project (projectRef param required).",
    params: ["projectRef"],
    maxTtlSeconds: SUPABASE_MAX_TTL_SECONDS,
  },
  {
    id: "functions-deploy",
    provider: "supabase",
    version: 1,
    displayName: "Deploy Edge Functions",
    description: "Deploy Edge Functions to one project (projectRef param required).",
    params: ["projectRef"],
    maxTtlSeconds: SUPABASE_MAX_TTL_SECONDS,
  },
  {
    id: "project-service-key",
    provider: "supabase",
    version: 1,
    displayName: "Project service-role key",
    description:
      "The project's service-role API key (projectRef param required), served from org-owned custody captured at connect — no user-derived token and no Management API call on the resolve path. The key itself is long-lived (TTL bounds this issuance's ledger row, not the key); revoke by rotating the key in Supabase.",
    params: ["projectRef"],
    maxTtlSeconds: SUPABASE_MAX_TTL_SECONDS,
    // SI4: custody-served — the broker reads the enveloped per-project key
    // map instead of minting against the management plane.
    custodyKind: "supabase_project_secret",
  },
] as const;

/**
 * The PKCE authorize URL carrying our signed single-use state (the
 * `supabase_org_id ↔ org_id` keystone rides this state, never inference).
 */
export function buildSupabaseAuthorizeUrl(input: {
  clientId: string;
  state: string;
  redirectUri: string;
  codeChallenge?: string;
}): string {
  const url = new URL(`${API_BASE}/v1/oauth/authorize`);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Verified grant from the PKCE code exchange. The refresh token is
 *  custody-envelope material ONLY; the access token is short-lived. */
export interface SupabaseOauthGrant {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

function parseTokenResponse(payload: Record<string, unknown>): SupabaseOauthGrant | null {
  const accessToken = payload.access_token;
  const refreshToken = payload.refresh_token;
  const expiresIn = payload.expires_in;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof refreshToken !== "string" ||
    !refreshToken ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return null;
  }
  return { accessToken, refreshToken, expiresIn };
}

/**
 * Exchange the callback's code for the token pair (`POST /v1/oauth/token`,
 * PKCE: the code_verifier must match the challenge the authorize URL carried).
 * Null on any failure — callers fail closed.
 */
export async function exchangeSupabaseOauthCode(
  credentials: SupabaseOauthCredentials,
  input: { code: string; redirectUri: string; codeVerifier: string },
  fetchImpl: FetchLike = fetch,
): Promise<SupabaseOauthGrant | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  try {
    const response = await fetchImpl(`${API_BASE}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) return null;
    return parseTokenResponse((await response.json()) as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Derive a fresh short-lived access token from the refresh token
 * (`grant_type=refresh_token`). Supabase ROTATES the refresh token on use —
 * the returned `refreshToken` is the rotated one (falling back to the input
 * when the response omits it) and MUST replace custody. Null = the provider
 * refused (the grant was revoked provider-side) — callers fail closed.
 */
export async function refreshSupabaseAccess(
  credentials: SupabaseOauthCredentials,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<SupabaseOauthGrant | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
  });
  let payload: Record<string, unknown>;
  try {
    const response = await fetchImpl(`${API_BASE}/v1/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!response.ok) return null;
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const accessToken = payload.access_token;
  const expiresIn = payload.expires_in;
  if (
    typeof accessToken !== "string" ||
    !accessToken ||
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return null;
  }
  const rotated = payload.refresh_token;
  return {
    accessToken,
    refreshToken: typeof rotated === "string" && rotated ? rotated : refreshToken,
    expiresIn,
  };
}

/** The organization behind the grant (`GET /v1/organizations`) — the
 *  connection's external anchor. Null when the token can see no org. */
export async function discoverSupabaseOrg(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ supabaseOrgId: string; orgName: string | null } | null> {
  try {
    const response = await fetchImpl(`${API_BASE}/v1/organizations`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Array<{ id?: unknown; name?: unknown }>;
    const org = Array.isArray(body) ? body[0] : undefined;
    if (typeof org?.id !== "string" || !org.id) return null;
    return {
      supabaseOrgId: org.id,
      orgName: typeof org.name === "string" ? org.name : null,
    };
  } catch {
    return null;
  }
}

/** Best-effort project facts (`GET /v1/projects`): safe {ref, name}
 *  projections, capped. Null = unavailable — connect proceeds without them. */
export async function listSupabaseProjects(
  accessToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<Array<{ ref: string; name: string | null }> | null> {
  try {
    const response = await fetchImpl(`${API_BASE}/v1/projects`, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Array<{ id?: unknown; ref?: unknown; name?: unknown }>;
    if (!Array.isArray(body)) return null;
    return body
      .map((p) => ({
        ref: typeof p.ref === "string" ? p.ref : typeof p.id === "string" ? p.id : null,
        name: typeof p.name === "string" ? p.name : null,
      }))
      .filter((p): p is { ref: string; name: string | null } => p.ref !== null)
      .slice(0, SUPABASE_MAX_PROJECTS);
  } catch {
    return null;
  }
}

/**
 * Per-project service-role keys (SI4): `GET /v1/projects/{ref}/api-keys`
 * for each ref, keeping the `service_role` entry. Best-effort per project —
 * a ref whose keys cannot be read is simply absent from the map. Null when
 * NO ref could be read (callers keep existing custody rather than
 * overwriting it with an empty map).
 */
export async function fetchSupabaseProjectServiceKeys(
  accessToken: string,
  projectRefs: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<Record<string, string> | null> {
  const keys: Record<string, string> = {};
  for (const ref of projectRefs.slice(0, SUPABASE_MAX_PROJECTS)) {
    try {
      const response = await fetchImpl(`${API_BASE}/v1/projects/${ref}/api-keys`, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) continue;
      const body = (await response.json()) as Array<{ name?: unknown; api_key?: unknown }>;
      if (!Array.isArray(body)) continue;
      const serviceRole = body.find((k) => k.name === "service_role");
      if (typeof serviceRole?.api_key === "string" && serviceRole.api_key) {
        keys[ref] = serviceRole.api_key;
      }
    } catch {
      // Best-effort per project.
    }
  }
  return Object.keys(keys).length > 0 ? keys : null;
}

export function createSupabaseProvider(
  credentials: SupabaseOauthCredentials,
  fetchImpl: FetchLike = fetch,
): IntegrationProvider {
  const broker: CredentialBrokerCapability = {
    scopeTemplates() {
      return SUPABASE_SCOPE_TEMPLATES;
    },
    async mintCredential(input): Promise<MintCredentialOutcome> {
      const known = SUPABASE_SCOPE_TEMPLATES.some((t) => t.id === input.template);
      if (!known) return { ok: false, reason: "template_unknown" };
      if (!input.parent) {
        return { ok: false, reason: "provider_error", detail: "parent credential missing" };
      }

      // Validate template params BEFORE the refresh call: a refresh consumes
      // (rotates) the parent, so a doomed mint must fail before spending it.
      let projectRef: string | null = null;
      if (input.template === "db-migrate" || input.template === "functions-deploy") {
        const ref = input.params.projectRef;
        if (typeof ref !== "string" || !ref) {
          return {
            ok: false,
            reason: "provider_error",
            detail: `${input.template} requires projectRef`,
          };
        }
        projectRef = ref;
      }

      const refreshed = await refreshSupabaseAccess(credentials, input.parent.credential, fetchImpl);
      if (!refreshed) {
        // A refused refresh means the grant was revoked provider-side — the
        // parent can no longer cover ANY template.
        return { ok: false, reason: "parent_grant_insufficient", detail: "refresh refused" };
      }

      const credential: Record<string, string> =
        projectRef !== null
          ? { accessToken: refreshed.accessToken, projectRef }
          : { accessToken: refreshed.accessToken };

      // Report the SHORTER of the clamped request and the provider-fixed
      // expiry honestly (risks R5) — the ledger records the ACTUAL lifetime.
      const lifetimeSeconds = Math.min(input.ttlSeconds, refreshed.expiresIn);
      return {
        ok: true,
        value: {
          credential,
          // No provider-side revoke exists for these tokens; TTL is the backstop.
          providerRef: null,
          expiresAt: new Date(input.nowMs + lifetimeSeconds * 1000),
          ...(refreshed.refreshToken !== input.parent.credential
            ? { rotatedParentCredential: refreshed.refreshToken }
            : {}),
        },
      };
    },
    async revokeCredential(): Promise<boolean> {
      return false;
    },
  };

  return {
    id: "supabase",
    displayName: "Supabase",
    connectKind: "oauth",
    capabilities: ["connect", "credential-broker"],

    broker,

    buildAuthorizeUrl(input) {
      return buildSupabaseAuthorizeUrl({
        clientId: credentials.clientId,
        state: input.state,
        redirectUri: input.redirectUri,
        ...(input.codeChallenge ? { codeChallenge: input.codeChallenge } : {}),
      });
    },
  };
}
