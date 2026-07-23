/**
 * Provider archetype mapping for the per-connection detail surface.
 *
 * IR1 note: the hub no longer uses archetypes — it renders category sections
 * straight from the served Integration Registry (`registry.ts`). This static
 * map exists ONLY for `connection-detail.tsx`'s body branching (messaging vs
 * infrastructure vs source control), which IR2 absorbs into the provider
 * space — this file is deleted with it.
 */

export type Archetype = "source-control" | "messaging" | "infrastructure";

const PROVIDER_ARCHETYPES: Record<string, Archetype> = {
  github: "source-control",
  slack: "messaging",
  discord: "messaging",
  cloudflare: "infrastructure",
  supabase: "infrastructure",
  aws: "infrastructure",
};

/** Archetype for a provider id; null for ids the map does not know. */
export function archetypeForProvider(id: string): Archetype | null {
  return PROVIDER_ARCHETYPES[id] ?? null;
}
