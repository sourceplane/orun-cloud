/**
 * Pure view-model for the redesigned Integrations hub (saas-integrations-console
 * IX1). Dependency-free (no React) so the summary/filter/meta logic is
 * unit-testable and the hub stays a pure projection of the served registry +
 * this org's connections + (best-effort) brokered secret metadata.
 *
 * SP-A5 discipline: the brokered read is a best-effort enrichment — every
 * function degrades to a sensible value when it is absent, so the hub renders
 * without it.
 */

import type {
  IntegrationCategory,
  IntegrationDescriptor,
  PublicConnection,
} from "@saas/contracts/integrations";
import type { PublicSecretMetadata } from "@saas/contracts/config";
import { cardState, type IntegrationCardState } from "./registry";
import { connectionDisplayName, connectionScopeMeta } from "./connections";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Status leg of the hub filter bar. */
export type HubStatusFilter = "all" | "connected" | "available";

/** The three summary tiles at the top of the hub. */
export interface HubSummary {
  /** Live (active/pending) connections. */
  connectedCount: number;
  /** Distinct categories the registry spans (the "across N categories" caption). */
  categoryCount: number;
  /** Brokered secrets minted from connections (best-effort; 0 without the read). */
  brokeredCount: number;
  /** Distinct providers those brokered secrets bind to. */
  brokeredProviders: number;
  /** Live providers not yet connected but connectable/lockable/configurable. */
  availableCount: number;
}

/** A brokered secret bound to a connection (the fields the hub reads). */
type BrokeredSecret = Pick<PublicSecretMetadata, "source" | "binding">;

/** Only the brokered secrets — static/rotated rows never count here. */
function brokeredOnly(secrets: readonly BrokeredSecret[]): BrokeredSecret[] {
  return secrets.filter((s) => s.source === "brokered" && s.binding != null);
}

/** Map of connectionId → number of brokered secrets bound to it. */
export function brokeredByConnection(
  secrets: readonly BrokeredSecret[] | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!secrets) return out;
  for (const s of brokeredOnly(secrets)) {
    const cid = s.binding?.connectionId;
    if (cid) out.set(cid, (out.get(cid) ?? 0) + 1);
  }
  return out;
}

/** Total brokered secrets and the distinct providers they bind to. */
export function brokeredSummary(
  secrets: readonly BrokeredSecret[] | null | undefined,
): { total: number; providers: number } {
  if (!secrets) return { total: 0, providers: 0 };
  const only = brokeredOnly(secrets);
  const providers = new Set<string>();
  for (const s of only) {
    if (s.binding?.provider) providers.add(s.binding.provider);
  }
  return { total: only.length, providers: providers.size };
}

/** Whether a connection counts as "connected" for the hub (live rows only). */
export function isLiveConnection(c: Pick<PublicConnection, "status">): boolean {
  return c.status === "active" || c.status === "pending";
}

/** The three summary tiles, derived purely from the reads. */
export function hubSummary(
  connections: readonly PublicConnection[],
  descriptors: readonly IntegrationDescriptor[],
  brokeredSecrets: readonly BrokeredSecret[] | null | undefined,
): HubSummary {
  const connectedCount = connections.filter(isLiveConnection).length;
  const categoryCount = new Set(descriptors.map((d) => d.category)).size;
  const availableCount = descriptors.filter((d) => {
    const state = cardState(d, connections);
    return state === "available" || state === "locked" || state === "configure";
  }).length;
  const { total, providers } = brokeredSummary(brokeredSecrets);
  return {
    connectedCount,
    categoryCount,
    brokeredCount: total,
    brokeredProviders: providers,
    availableCount,
  };
}

/** Categories present in the registry, in CATEGORY_ORDER, for the filter bar. */
export function presentCategories(
  descriptors: readonly IntegrationDescriptor[],
  order: readonly IntegrationCategory[],
): IntegrationCategory[] {
  const present = new Set(descriptors.map((d) => d.category));
  return order.filter((c) => present.has(c));
}

/** Does a card state satisfy the status filter leg? */
export function matchesStatus(state: IntegrationCardState, filter: HubStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "connected") return state === "connected";
  // "available" groups the connectable-but-not-connected states.
  return state === "available" || state === "locked" || state === "configure";
}

/** Case-insensitive search over display name, id, tagline, and category label. */
export function matchesSearch(
  descriptor: Pick<IntegrationDescriptor, "displayName" | "id" | "tagline" | "category">,
  query: string,
  categoryLabel: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    descriptor.displayName.toLowerCase().includes(q) ||
    descriptor.id.toLowerCase().includes(q) ||
    descriptor.tagline.toLowerCase().includes(q) ||
    categoryLabel.toLowerCase().includes(q)
  );
}

/** Whole-days-since label, e.g. "254d"; null when never connected. */
export function connectionAgeLabel(
  connectedAt: string | null | undefined,
  nowMs: number = Date.now(),
): string | null {
  if (!connectedAt) return null;
  const t = new Date(connectedAt).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.max(0, Math.floor((nowMs - t) / DAY_MS));
  return `${days}d`;
}

/** GitHub repo-grant clause for the meta line ("All repositories" / "Selected"). */
export function repositoryClause(repositorySelection: string | null | undefined): string | null {
  if (!repositorySelection) return null;
  return repositorySelection === "all" ? "All repositories" : "Selected repositories";
}

/**
 * The dot-joined meta line under a connected row, e.g.
 * "acme-platform · Account-shared · All repositories · 254d" or
 * "acme-prod · Workspace-private · 3 brokered secrets".
 *
 * Order: display name · scope · (brokered count | repo grant) · age. When a
 * brokered-secret count is present it takes the detail slot and the age is
 * dropped (mirrors the mockup's infrastructure rows).
 */
export function connectedMetaLine(
  connection: PublicConnection,
  opts: { brokeredCount?: number; nowMs?: number } = {},
): string {
  const parts: string[] = [
    connectionDisplayName(connection),
    connectionScopeMeta(connection.scope).label,
  ];
  const brokered = opts.brokeredCount ?? 0;
  if (brokered > 0) {
    parts.push(`${brokered} brokered secret${brokered === 1 ? "" : "s"}`);
  } else {
    const repo = repositoryClause(connection.repositorySelection);
    if (repo) parts.push(repo);
    const age = connectionAgeLabel(connection.connectedAt, opts.nowMs);
    if (age) parts.push(age);
  }
  return parts.join(" · ");
}

/** "GitLab, Discord, and AWS are" — Oxford-joined provider list for the roadmap. */
export function roadmapListSentence(names: readonly string[]): string {
  if (names.length === 0) return "More integrations are";
  if (names.length === 1) return `${names[0]} is`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]} are`;
}
