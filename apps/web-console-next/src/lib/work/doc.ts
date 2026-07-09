// Pure helpers for the work document surface (orun-work-v3 PM0; unit-tested,
// no React). Digest/slug/fork logic lives here so the components stay thin.

import type { WorkDocRevisionView } from "@saas/contracts/work";

/** `sha256:ab12…` → `ab12ef0` — the short form history rails render. */
export function shortDigest(revision: string): string {
  const hex = revision.startsWith("sha256:") ? revision.slice(7) : revision;
  return hex.slice(0, 7);
}

/** Parents with more than one child — a fork the UI must surface (design
 *  §1.4: fork-visible LWW; a fork is a banner, never a silent overwrite). */
export function forkParents(revisions: Pick<WorkDocRevisionView, "revision" | "parent">[]): Set<string> {
  const children = new Map<string, number>();
  for (const r of revisions) {
    if (!r.parent) continue;
    children.set(r.parent, (children.get(r.parent) ?? 0) + 1);
  }
  return new Set([...children.entries()].filter(([, n]) => n > 1).map(([p]) => p));
}

const SLUG_RE = /^[a-z0-9-]+$/;
const PREFIX_RE = /^[A-Z]{2,5}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

export function isValidPrefix(prefix: string): boolean {
  return PREFIX_RE.test(prefix);
}

/** Title → slug, mirroring the mutator's kebab rule (lowercase a–z0–9-). */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/** Title → a suggested task-key prefix (2–5 uppercase), e.g.
 *  "Checkout flow" → "CHECK" / "auth" → "AUTH" / "x" → "WRK". */
export function suggestPrefix(title: string): string {
  const letters = title.toUpperCase().replace(/[^A-Z]/g, "");
  return letters.length >= 2 ? letters.slice(0, 5) : "WRK";
}
