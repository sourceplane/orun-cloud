/**
 * Presentation helpers for catalog kinds and lifecycles (saas-service-catalog).
 *
 * Pure and dependency-free so the thick list row, the detail panel, and the unit
 * tests share one mapping. Following the `entity-nav.ts` / `sidebar.tsx` split,
 * this module owns the *data* (canonical key, colour classes, badge variant);
 * the renderer owns icon resolution. Every colour is a literal Tailwind class so
 * the JIT compiler sees it (no dynamically-built class strings).
 */

/** Badge variants understood by `components/ui/badge.tsx`. */
export type BadgeVariant = "default" | "secondary" | "destructive" | "warning" | "success" | "outline";

export interface KindTone {
  /** Canonical kind key (icon lookup happens in the renderer). */
  key: string;
  /** Avatar tint — background + foreground. */
  avatar: string;
}

/**
 * Stable per-kind tint so the same kind always reads the same colour while
 * scanning. Amber (the brand `primary`) is reserved for Component, the most
 * common kind; the rest use restrained Tailwind palette tints that work in both
 * themes.
 */
const KIND_TONES: Record<string, KindTone> = {
  Component: { key: "Component", avatar: "bg-primary/15 text-primary" },
  API: { key: "API", avatar: "bg-sky-500/15 text-sky-600 dark:text-sky-400" },
  Resource: { key: "Resource", avatar: "bg-violet-500/15 text-violet-600 dark:text-violet-400" },
  System: { key: "System", avatar: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" },
  Domain: { key: "Domain", avatar: "bg-rose-500/15 text-rose-600 dark:text-rose-400" },
  Group: { key: "Group", avatar: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400" },
};

const FALLBACK_TONE: KindTone = { key: "", avatar: "bg-muted text-muted-foreground" };

/** Resolve a kind's tone, case-insensitively; unknown kinds degrade to neutral. */
export function kindTone(kind: string): KindTone {
  const hit = Object.values(KIND_TONES).find((t) => t.key.toLowerCase() === kind.toLowerCase());
  return hit ?? FALLBACK_TONE;
}

/**
 * Map a lifecycle string to a tone for the row accent rail + the detail badge.
 * Lifecycle is free-text from the git snapshot, so matching is substring- and
 * case-insensitive over the common Backstage/IDP vocabulary, with a neutral
 * fallback (and a distinct "unknown" tone when lifecycle is absent entirely).
 */
export function lifecycleTone(lifecycle: string | null | undefined): {
  /** Badge variant for the lifecycle chip. */
  variant: BadgeVariant;
  /** Accent-rail colour class (the left edge of the thick row). */
  accent: string;
} {
  if (!lifecycle) return { variant: "outline", accent: "bg-border" };
  const l = lifecycle.toLowerCase();
  if (/(prod|ga|stable|generally)/.test(l)) return { variant: "success", accent: "bg-success" };
  if (/(stag|beta|preview|canary|rc)/.test(l)) return { variant: "warning", accent: "bg-warning" };
  if (/(deprecat|retir|sunset|eol|end-of-life|legacy)/.test(l)) {
    return { variant: "destructive", accent: "bg-destructive" };
  }
  if (/(experiment|alpha|dev|incubat|wip|draft)/.test(l)) return { variant: "secondary", accent: "bg-muted-foreground/60" };
  return { variant: "secondary", accent: "bg-muted-foreground/40" };
}
