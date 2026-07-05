/**
 * Workspace Overview view-model (saas-workspace-overview WO2).
 *
 * The pure heart of the Overview landing: it turns the data the console already
 * loads — the catalog rollup (`CatalogService[]`), the org runs feed
 * (`RunRow[]`), and the linked repos — into the small selectors the three bands
 * render. Everything here is derived, never authored; the console composes what
 * git produced (`18-state.md`).
 *
 * Pure and dependency-free (time-dependent output takes an explicit `now`), so
 * the component and the unit tests share one mapping.
 */

import type { CatalogService } from "../catalog-portal/model";
import { needsAttention, scorecardOf, tierOf } from "../catalog-portal/model";
import type { RunRow } from "../runs-portal/model";
import type { RunStatus, RepoFacet } from "@saas/contracts/state";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/**
 * Which of the four landing states the workspace is in — decides whether the
 * page shows the full layout, a first-run hint, or the link-a-repo CTA.
 *
 * - `no-repo`  — no repo linked yet → the centered "link a repository" CTA.
 * - `no-plan`  — a repo is linked but the catalog is empty → "run orun plan".
 * - `ready`    — repos + catalog → the full three-band layout.
 */
export type OverviewState = "no-repo" | "no-plan" | "ready";

export function resolveOverviewState(input: {
  repoCount: number;
  catalogCount: number;
}): OverviewState {
  if (input.repoCount === 0) return "no-repo";
  if (input.catalogCount === 0) return "no-plan";
  return "ready";
}

/** The Activity signal tile: runs in the last 7d, success rate, latest status. */
export interface OverviewActivity {
  /** Runs created in the last 7 days. */
  last7d: number;
  /** Success rate over finished (succeeded + failed) runs in the last 7d, 0–100. */
  successRate: number;
  /** Runs currently running (over the loaded feed). */
  running: number;
  /** The most recent run's status (rows are newest-first), or null when empty. */
  lastStatus: RunStatus | null;
}

/**
 * Roll the loaded run feed into the Activity tile. `rows` are expected
 * newest-first (as `listOrgRuns` returns them); the rate is computed over runs
 * that both finished and fall in the 7-day window, so a quiet week reads 0
 * rather than inheriting an old rate.
 */
export function overviewActivity(rows: readonly RunRow[], now: number): OverviewActivity {
  const weekAgo = now - WEEK_MS;
  const recent = rows.filter((r) => r.createdMs >= weekAgo);
  const succeeded = recent.filter((r) => r.status === "succeeded").length;
  const failed = recent.filter((r) => r.status === "failed").length;
  const finished = succeeded + failed;
  return {
    last7d: recent.length,
    successRate: finished > 0 ? Math.round((succeeded / finished) * 100) : 0,
    running: rows.filter((r) => r.status === "running").length,
    lastStatus: rows[0]?.status ?? null,
  };
}

/** Maturity-tier counts across scored (non-resource) services, for the mini-bar. */
export interface TierCounts {
  gold: number;
  silver: number;
  bronze: number;
  /** Scored services (gold + silver + bronze). */
  scored: number;
}

export function tierCounts(services: readonly CatalogService[]): TierCounts {
  let gold = 0;
  let silver = 0;
  let bronze = 0;
  for (const s of services) {
    const { score, known } = scorecardOf(s);
    const tier = tierOf(score, known);
    if (tier === "Gold") gold += 1;
    else if (tier === "Silver") silver += 1;
    else if (tier === "Bronze") bronze += 1;
  }
  return { gold, silver, bronze, scored: gold + silver + bronze };
}

/** The share (0–100) that is healthy — the inverse of the needs-attention rate. */
export function healthyPct(total: number, attention: number): number {
  if (total <= 0) return 0;
  return Math.round(((total - attention) / total) * 100);
}

/** Distinct source environments across the catalog (for the identity quick-facts). */
export function environmentCount(services: readonly CatalogService[]): number {
  const envs = new Set<string>();
  for (const s of services) if (s.sourceEnvironment) envs.add(s.sourceEnvironment);
  return envs.size;
}

// ── Repo facet (WO5) ─────────────────────────────────────────

/**
 * The primary repo facet for the workspace hero: the most-recently-synced one.
 * `listRepoFacets` already returns rows ordered `synced_at DESC`, so the first
 * is the default primary (matching the derived-primary rule in model.md §4c).
 */
export function primaryRepoFacet(facets: readonly RepoFacet[]): RepoFacet | null {
  return facets[0] ?? null;
}

/** The content-addressed digest of a facet's overview doc, or null. */
export function docDigestOf(facet: RepoFacet | null | undefined): string | null {
  const d = facet?.docRef?.["digest"];
  return typeof d === "string" && d.length > 0 ? d : null;
}

/** The repo segment of an entity key `<namespace>/<repo>/<name>`, or null. */
export function repoFromEntityRef(entityRef: string | null | undefined): string | null {
  if (!entityRef) return null;
  const parts = entityRef.split("/");
  return parts.length >= 3 ? parts[1]! : null;
}

/** Short (7-char) commit sha for the provenance line, or null. */
export function shortSha(commit: string | null | undefined): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/** The first `n` services needing attention (unowned / degraded / down). */
export function topAttention(services: readonly CatalogService[], n: number): CatalogService[] {
  const out: CatalogService[] = [];
  for (const s of services) {
    if (needsAttention(s)) out.push(s);
    if (out.length >= n) break;
  }
  return out;
}
