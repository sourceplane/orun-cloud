/**
 * Pure archetype grouping (saas-integration-hub design §6).
 *
 * Dependency-free (no React, no `next/*`) so the marketplace grouping is
 * unit-testable. Consumed by the hub (grouped "Connect a provider" section)
 * AND the connection-detail surface (`archetypeForProvider`) — keep the
 * exported names/shapes stable.
 *
 * The scope-template display catalog that used to live here was deleted by
 * saas-secrets-platform SP0c: the console now derives templates from the bulk
 * capability read (`client.integrations.listSecretsCapabilities`, SP-A1) —
 * see `config/bind-secret-flow.ts` `templatesForProvider`.
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
