/**
 * Pure archetype grouping + broker scope-template display catalog
 * (saas-integration-hub design §6).
 *
 * Dependency-free (no React, no `next/*`) so the marketplace grouping and the
 * "what can be minted" catalog are unit-testable. Consumed by the hub (grouped
 * "Connect a provider" section) AND the connection-detail surface
 * (`archetypeForProvider`, `SCOPE_TEMPLATE_CATALOG`) — keep the exported
 * names/shapes stable.
 */

import { providerById } from "./providers";

export type Archetype = "source-control" | "messaging" | "infrastructure";

/** Stable marketplace ordering (design §6). */
export const ARCHETYPE_ORDER: Archetype[] = ["source-control", "messaging", "infrastructure"];

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  "source-control": "Source control",
  messaging: "Messaging",
  infrastructure: "Infrastructure",
};

/** Archetype for a provider id; null for ids the catalog does not know. */
export function archetypeForProvider(id: string): Archetype | null {
  return providerById(id)?.archetype ?? null;
}

/**
 * Group items carrying an `archetype` into labeled buckets in
 * `ARCHETYPE_ORDER`, dropping empty archetypes and preserving input order
 * within each bucket.
 */
export function groupByArchetype<T extends { archetype: Archetype }>(
  items: T[],
): Array<{ archetype: Archetype; label: string; items: T[] }> {
  return ARCHETYPE_ORDER.map((archetype) => ({
    archetype,
    label: ARCHETYPE_LABELS[archetype],
    items: items.filter((item) => item.archetype === archetype),
  })).filter((group) => group.items.length > 0);
}

// ── Broker scope-template display catalog ───────────────────
// Display-only mirror of the worker adapters' template catalogs — ids,
// displayName, description, params, and maxTtlSeconds copied EXACTLY from
// `apps/integrations-worker/src/providers/cloudflare.ts`
// (CLOUDFLARE_SCOPE_TEMPLATES) and `.../supabase.ts` (SUPABASE_SCOPE_TEMPLATES).
// The worker stays the source of truth for what a mint actually issues; this
// catalog only tells the console what CAN be minted.

export interface ScopeTemplateInfo {
  id: string;
  displayName: string;
  description: string;
  params: string[];
  maxTtlSeconds: number;
}

const HOUR_SECONDS = 60 * 60;

export const SCOPE_TEMPLATE_CATALOG: Record<string, ScopeTemplateInfo[]> = {
  cloudflare: [
    {
      id: "workers-deploy",
      displayName: "Deploy Workers",
      description:
        "Edit Workers scripts and KV in the connected account, plus account read. No DNS, no R2, no billing.",
      params: [],
      maxTtlSeconds: HOUR_SECONDS,
    },
    {
      id: "pages-deploy",
      displayName: "Deploy Pages",
      description: "Edit Pages projects in the connected account, plus account read.",
      params: [],
      maxTtlSeconds: HOUR_SECONDS,
    },
    {
      id: "dns-edit",
      displayName: "Edit DNS",
      description: "Edit DNS records in the named zones only (zoneIds param required).",
      params: ["zoneIds"],
      maxTtlSeconds: HOUR_SECONDS,
    },
    {
      id: "r2-data",
      displayName: "R2 data access",
      description: "Read/write R2 objects in the connected account's buckets.",
      params: ["buckets"],
      maxTtlSeconds: HOUR_SECONDS,
    },
    {
      id: "account-read",
      displayName: "Account read",
      description: "Read-only access to account settings, Workers, and zones.",
      params: [],
      maxTtlSeconds: HOUR_SECONDS,
    },
  ],
  supabase: [
    {
      id: "management-access",
      displayName: "Management API access",
      description:
        "A short-lived Management-API access token for the connected Supabase organization. Breadth is the OAuth grant (org-wide); TTL is provider-fixed and reported honestly in the ledger.",
      params: [],
      maxTtlSeconds: HOUR_SECONDS,
    },
    {
      id: "db-migrate",
      displayName: "Run database migrations",
      description:
        "The credential bundle the migration runner needs for one project (projectRef param required).",
      params: ["projectRef"],
      maxTtlSeconds: HOUR_SECONDS,
    },
    {
      id: "functions-deploy",
      displayName: "Deploy Edge Functions",
      description: "Deploy Edge Functions to one project (projectRef param required).",
      params: ["projectRef"],
      maxTtlSeconds: HOUR_SECONDS,
    },
  ],
};
