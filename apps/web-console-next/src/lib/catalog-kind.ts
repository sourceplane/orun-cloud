/**
 * Presentation helpers for catalog kinds and lifecycles (saas-service-catalog).
 *
 * Calm, monochrome system: kinds are told apart by their icon, not by colour,
 * and lifecycle is a subtle neutral-opacity step on the row's accent rail. The
 * brand amber is reserved exclusively for the *selected* state elsewhere, so the
 * list reads as one quiet surface rather than a field of status colours.
 *
 * Pure and dependency-free so the list row, the detail panel, and the unit tests
 * share one mapping; the renderer owns icon resolution (mirrors `sidebar.tsx`).
 */

/** Badge variants understood by `components/ui/badge.tsx`. */
export type BadgeVariant = "default" | "secondary" | "destructive" | "warning" | "success" | "outline";

/** Canonical catalog kinds, in display casing. */
const KINDS = ["Component", "API", "Resource", "System", "Domain", "Group"];

/** One neutral avatar tint for every kind — differentiation is by icon alone. */
const NEUTRAL_AVATAR = "bg-muted text-muted-foreground";

export interface KindTone {
  /** Canonical kind key (icon lookup happens in the renderer); "" if unknown. */
  key: string;
  /** Avatar tint — background + foreground. */
  avatar: string;
}

/** Resolve a kind's tone, case-insensitively. Unknown kinds keep the same tint. */
export function kindTone(kind: string): KindTone {
  const key = KINDS.find((k) => k.toLowerCase() === kind.toLowerCase()) ?? "";
  return { key, avatar: NEUTRAL_AVATAR };
}

/**
 * Map a lifecycle string to a calm tone: a neutral-opacity accent rail (no
 * red/green/amber), and an `outline` badge so the chip is a quiet pill. Matching
 * is substring- and case-insensitive over the common IDP vocabulary; the accent
 * darkens slightly for "more live" stages so there is a gentle signal without
 * colour. Free-text and absent lifecycles degrade to a faint rail.
 */
export function lifecycleTone(lifecycle: string | null | undefined): {
  /** Badge variant for the lifecycle chip (always neutral). */
  variant: BadgeVariant;
  /** Accent-rail colour class (the left edge of the thick row). */
  accent: string;
} {
  if (!lifecycle) return { variant: "outline", accent: "bg-border" };
  const l = lifecycle.toLowerCase();
  if (/(prod|ga|stable|generally)/.test(l)) return { variant: "outline", accent: "bg-foreground/30" };
  if (/(stag|beta|preview|canary|rc)/.test(l)) return { variant: "outline", accent: "bg-foreground/15" };
  if (/(deprecat|retir|sunset|eol|end-of-life|legacy)/.test(l)) return { variant: "outline", accent: "bg-foreground/10" };
  if (/(experiment|alpha|dev|incubat|wip|draft)/.test(l)) return { variant: "outline", accent: "bg-foreground/15" };
  return { variant: "outline", accent: "bg-foreground/15" };
}
