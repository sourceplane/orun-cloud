// Cloudflare adapter (saas-integration-hub IH5) — the credential-broker
// archetype, live. connectKind "token": the customer pastes an
// account-scoped parent API token once (risks D3 — Cloudflare offers no
// general OAuth for its API); the worker verifies it, discovers the
// account, and the paste is never re-shown. Mints are child account-owned
// tokens: template-shaped policies, expires_on = now + clamped TTL, named
// `orun/{org}/{template}/{mintId}` so the IH9 orphan sweep can reconcile.
//
// Custody rule: the pasted parent token is the single durable credential and
// lives ONLY as a provider_credentials envelope; everything minted from it
// is short-lived, scoped-down, ledgered, and revocable. The adapter never
// holds it — the broker handler decrypts custody per call and passes it as
// ParentCredentialContext.

import type { IntegrationScopeTemplate } from "@saas/contracts/integrations";
import type { FetchLike } from "../github-app.js";
import type {
  CredentialBrokerCapability,
  IntegrationProvider,
  MintCredentialOutcome,
  ParentCredentialContext,
} from "./types.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

/** Default mint TTL (risks D5): 15 minutes; hard ceiling one hour. */
export const CLOUDFLARE_DEFAULT_TTL_SECONDS = 15 * 60;
export const CLOUDFLARE_MAX_TTL_SECONDS = 60 * 60;

/**
 * The v1 template catalog (design §5.2). Descriptions state the EFFECTIVE
 * breadth honestly (risks R5). Minted tokens are named
 * `orun/{org}/{template}/{mintId}` provider-side so the IH9 orphan sweep can
 * reconcile ledger truth against the Cloudflare account.
 */
export const CLOUDFLARE_SCOPE_TEMPLATES: readonly IntegrationScopeTemplate[] = [
  {
    id: "workers-deploy",
    provider: "cloudflare",
    version: 1,
    displayName: "Deploy Workers",
    description:
      "Edit Workers scripts and KV in the connected account, plus account read. No DNS, no R2, no billing.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "pages-deploy",
    provider: "cloudflare",
    version: 1,
    displayName: "Deploy Pages",
    description: "Edit Pages projects in the connected account, plus account read.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "dns-edit",
    provider: "cloudflare",
    version: 1,
    displayName: "Edit DNS",
    description: "Edit DNS records in the named zones only (zoneIds param required).",
    params: ["zoneIds"],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "r2-data",
    provider: "cloudflare",
    version: 1,
    displayName: "R2 data access",
    description: "Read/write R2 objects in the connected account's buckets.",
    params: ["buckets"],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
  {
    id: "account-read",
    provider: "cloudflare",
    version: 1,
    displayName: "Account read",
    description: "Read-only access to account settings, Workers, and zones.",
    params: [],
    maxTtlSeconds: CLOUDFLARE_MAX_TTL_SECONDS,
  },
] as const;

/** Verified parent-token facts (`GET /user/tokens/verify`). Null = the
 *  paste is not a live Cloudflare token — callers fail closed. */
export interface CloudflareTokenVerification {
  tokenId: string;
  status: string;
  expiresOn: string | null;
}

export async function verifyCloudflareParentToken(
  parentToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<CloudflareTokenVerification | null> {
  try {
    const response = await fetchImpl(`${API_BASE}/user/tokens/verify`, {
      method: "GET",
      headers: { authorization: `Bearer ${parentToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: boolean;
      result?: { id?: unknown; status?: unknown; expires_on?: unknown };
    };
    if (body.success !== true || typeof body.result?.id !== "string") return null;
    return {
      tokenId: body.result.id,
      status: typeof body.result.status === "string" ? body.result.status : "unknown",
      expiresOn: typeof body.result.expires_on === "string" ? body.result.expires_on : null,
    };
  } catch {
    return null;
  }
}

/** The account behind the parent token (`GET /accounts`) — the connection's
 *  external anchor. Null when the token can see no account. */
export async function discoverCloudflareAccount(
  parentToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ accountExternalId: string; accountName: string | null } | null> {
  try {
    const response = await fetchImpl(`${API_BASE}/accounts?per_page=1`, {
      method: "GET",
      headers: { authorization: `Bearer ${parentToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      success?: boolean;
      result?: Array<{ id?: unknown; name?: unknown }>;
    };
    const account = Array.isArray(body.result) ? body.result[0] : undefined;
    if (body.success !== true || typeof account?.id !== "string") return null;
    return {
      accountExternalId: account.id,
      accountName: typeof account.name === "string" ? account.name : null,
    };
  } catch {
    return null;
  }
}

/** Permission-group NAMES per template. Resolved to ids at mint time via the
 *  parent token's own permission-group listing — never hardcoded ids. A name
 *  the account cannot see is a `parent_grant_insufficient` (deny-by-default:
 *  template ⊄ parent grant). */
const TEMPLATE_PERMISSION_GROUPS: Record<string, readonly string[]> = {
  "workers-deploy": ["Workers Scripts Write", "Workers KV Storage Write", "Account Settings Read"],
  "pages-deploy": ["Pages Write", "Account Settings Read"],
  "dns-edit": ["DNS Write"],
  "r2-data": ["Workers R2 Storage Write"],
  "account-read": ["Account Settings Read"],
};

function templateResources(
  template: string,
  params: Record<string, unknown>,
  accountExternalId: string,
): Record<string, string> | null {
  if (template === "dns-edit") {
    const zoneIds = Array.isArray(params.zoneIds)
      ? params.zoneIds.filter((z): z is string => typeof z === "string" && /^[0-9a-f]{32}$/.test(z))
      : [];
    if (zoneIds.length === 0) return null;
    const resources: Record<string, string> = {};
    for (const zoneId of zoneIds) resources[`com.cloudflare.api.account.zone.${zoneId}`] = "*";
    return resources;
  }
  return { [`com.cloudflare.api.account.${accountExternalId}`]: "*" };
}

async function mintCloudflareToken(
  input: {
    template: string;
    params: Record<string, unknown>;
    ttlSeconds: number;
    nowMs: number;
    parent: ParentCredentialContext;
    mintRef: string;
  },
  fetchImpl: FetchLike,
): Promise<MintCredentialOutcome> {
  const accountId = input.parent.externalRef;
  if (!accountId) return { ok: false, reason: "provider_error", detail: "no account anchor" };

  const groupNames = TEMPLATE_PERMISSION_GROUPS[input.template];
  if (!groupNames) return { ok: false, reason: "template_unknown" };
  const resources = templateResources(input.template, input.params, accountId);
  if (!resources) {
    return { ok: false, reason: "provider_error", detail: "dns-edit requires zoneIds (32-hex ids)" };
  }

  // Resolve the template's group NAMES against what the parent can see —
  // the template ⊆ parent-grant check, deny-by-default.
  let groups: Array<{ id: string; name: string }>;
  try {
    const response = await fetchImpl(`${API_BASE}/user/tokens/permission_groups`, {
      method: "GET",
      headers: { authorization: `Bearer ${input.parent.credential}` },
    });
    if (!response.ok) {
      return { ok: false, reason: "provider_error", detail: `permission_groups http_${response.status}` };
    }
    const body = (await response.json()) as {
      success?: boolean;
      result?: Array<{ id?: unknown; name?: unknown }>;
    };
    if (body.success !== true || !Array.isArray(body.result)) {
      return { ok: false, reason: "provider_error", detail: "permission_groups unavailable" };
    }
    groups = body.result.filter(
      (g): g is { id: string; name: string } => typeof g.id === "string" && typeof g.name === "string",
    );
  } catch {
    return { ok: false, reason: "provider_error", detail: "permission_groups network_error" };
  }
  const byName = new Map(groups.map((g) => [g.name, g.id]));
  const missing = groupNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return { ok: false, reason: "parent_grant_insufficient", detail: `missing: ${missing.join(", ")}` };
  }

  const expiresOn = new Date(input.nowMs + input.ttlSeconds * 1000);
  try {
    const response = await fetchImpl(`${API_BASE}/accounts/${accountId}/tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.parent.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: input.mintRef,
        expires_on: expiresOn.toISOString(),
        policies: [
          {
            effect: "allow",
            resources,
            permission_groups: groupNames.map((name) => ({ id: byName.get(name)! })),
          },
        ],
      }),
    });
    const body = (await response.json()) as {
      success?: boolean;
      result?: { id?: unknown; value?: unknown };
      errors?: Array<{ message?: unknown }>;
    };
    if (!response.ok || body.success !== true || typeof body.result?.value !== "string") {
      const detail = String(body.errors?.[0]?.message ?? `http_${response.status}`).slice(0, 120);
      // A 403 on token creation is the parent grant refusing (needs
      // "Account API Tokens: Edit") — surface it as such, not as a 5xx.
      return response.status === 403
        ? { ok: false, reason: "parent_grant_insufficient", detail }
        : { ok: false, reason: "provider_error", detail };
    }
    return {
      ok: true,
      value: {
        credential: { token: body.result.value },
        providerRef: typeof body.result.id === "string" ? body.result.id : null,
        expiresAt: expiresOn,
      },
    };
  } catch {
    return { ok: false, reason: "provider_error", detail: "mint network_error" };
  }
}

export function createCloudflareProvider(fetchImpl: FetchLike = fetch): IntegrationProvider {
  const broker: CredentialBrokerCapability = {
    scopeTemplates() {
      return CLOUDFLARE_SCOPE_TEMPLATES;
    },
    async mintCredential(input) {
      const known = CLOUDFLARE_SCOPE_TEMPLATES.some((t) => t.id === input.template);
      if (!known) return { ok: false, reason: "template_unknown" };
      if (!input.parent) {
        return { ok: false, reason: "provider_error", detail: "parent credential missing" };
      }
      return mintCloudflareToken(
        {
          template: input.template,
          params: input.params,
          ttlSeconds: input.ttlSeconds,
          nowMs: input.nowMs,
          parent: input.parent,
          mintRef: input.mintRef ?? "orun/unnamed-mint",
        },
        fetchImpl,
      );
    },
    async revokeCredential(providerRef, _nowMs, parent): Promise<boolean> {
      if (!parent?.externalRef) return false;
      try {
        const response = await fetchImpl(
          `${API_BASE}/accounts/${parent.externalRef}/tokens/${providerRef}`,
          { method: "DELETE", headers: { authorization: `Bearer ${parent.credential}` } },
        );
        return response.ok;
      } catch {
        return false;
      }
    },
  };

  return {
    id: "cloudflare",
    displayName: "Cloudflare",
    connectKind: "token",
    capabilities: ["connect", "credential-broker"],

    broker,
  };
}
