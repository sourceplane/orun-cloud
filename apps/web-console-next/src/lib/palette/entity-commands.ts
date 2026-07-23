/**
 * Data-backed ⌘K commands (IC7, delivers PX6).
 *
 * Pure builders that map the shared query cache's data — catalog entities,
 * the org doc index, teams, and (when present in memory) secret names — into
 * palette `CommandDescriptor`s, plus the recency ranking. Dependency-free so
 * the whole "find anything" surface is unit-testable; the React wiring
 * (cache reads, lazy first-fetch on palette open, registration) lives in
 * `components/shell/palette-entity-source.tsx`.
 */

import type { OrgCatalogEntity, CatalogDoc } from "@saas/contracts/state";
import { encodeEntityKey } from "@/lib/catalog-entity-key";
import type { CommandDescriptor } from "@/components/shell/command-registry";

/** Registration caps — the palette renders every registered item, so each
 *  source is bounded (largest audited org: 93 entities; the cap is headroom,
 *  not a hidden truncation of typical orgs). */
export const MAX_ENTITY_COMMANDS = 300;
export const MAX_DOC_COMMANDS = 300;
export const MAX_SECRET_COMMANDS = 50;

export function entityCommands(orgSlug: string, entities: OrgCatalogEntity[]): CommandDescriptor[] {
  return entities.slice(0, MAX_ENTITY_COMMANDS).map((e) => ({
    id: `entity:${e.sourceProjectId}:${e.sourceEnvironment ?? ""}:${e.entityRef}`,
    label: e.name,
    group: "Catalog" as const,
    kind: "navigate" as const,
    to: `/orgs/${orgSlug}/catalog/${encodeEntityKey({
      sourceProjectId: e.sourceProjectId,
      sourceEnvironment: e.sourceEnvironment ?? null,
      entityRef: e.entityRef,
    })}`,
    icon: "Boxes",
    // Fuzzy surface: ref (component:default/api), kind, owner.
    keywords: [e.entityRef, e.kind, ...(e.owner ? [e.owner] : [])],
  }));
}

export function docCommands(orgSlug: string, docs: CatalogDoc[]): CommandDescriptor[] {
  return docs.slice(0, MAX_DOC_COMMANDS).map((d) => ({
    id: `doc:${d.projectId}:${d.sourceEnvironment ?? ""}:${d.entityRef}:${d.docKey}`,
    label: d.docKey === "overview" ? `${d.entityName} — overview` : `${d.entityName} — ${d.title}`,
    group: "Docs" as const,
    kind: "navigate" as const,
    to: `/orgs/${orgSlug}/docs/${encodeEntityKey({
      sourceProjectId: d.projectId,
      sourceEnvironment: d.sourceEnvironment ?? null,
      entityRef: d.entityRef,
    })}`,
    icon: "ScrollText",
    keywords: [d.entityRef, d.role, d.docKey, d.path ?? ""].filter(Boolean),
  }));
}

export function teamCommands(
  orgSlug: string,
  teams: Array<{ id: string; name: string; handle?: string | null }>,
): CommandDescriptor[] {
  return teams.map((t) => ({
    id: `team:${t.id}`,
    label: t.name,
    group: "Teams" as const,
    kind: "navigate" as const,
    to: `/orgs/${orgSlug}/teams/${t.id}`,
    icon: "UsersRound",
    keywords: t.handle ? [t.handle] : [],
  }));
}

/** Secrets never cold-fetch here (their cache entries are also exempt from
 *  IC3 persistence by D3) — only names already read by the Secrets surface
 *  this session are surfaced, and the command navigates to the console, it
 *  never carries a value. */
export function secretCommands(orgSlug: string, names: string[]): CommandDescriptor[] {
  return [...new Set(names)].slice(0, MAX_SECRET_COMMANDS).map((name) => ({
    id: `secret:${name}`,
    label: name,
    group: "Secrets" as const,
    kind: "navigate" as const,
    to: `/orgs/${orgSlug}/secrets`,
    icon: "KeyRound",
    keywords: ["secret"],
  }));
}

/** Stable recency partition: commands whose id is in `recentIds` first (in
 *  recency order), everything else after (original order preserved). */
export function rankByRecency<T extends { id: string }>(commands: T[], recentIds: string[]): T[] {
  if (recentIds.length === 0) return commands;
  const byId = new Map(commands.map((c) => [c.id, c]));
  const recent: T[] = [];
  const seen = new Set<string>();
  for (const id of recentIds) {
    const cmd = byId.get(id);
    if (cmd && !seen.has(id)) {
      recent.push(cmd);
      seen.add(id);
    }
  }
  if (recent.length === 0) return commands;
  return [...recent, ...commands.filter((c) => !seen.has(c.id))];
}

// ── Recents (localStorage ring) ─────────────────────────────

const RECENTS_KEY = "orun.next.palette-recents";
export const MAX_RECENTS = 12;

/** Ids of entity-ish commands this device ran recently, newest first. */
export function readRecentCommandIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Record a run (only entity-ish ids are worth remembering). */
export function recordRecentCommandId(id: string): void {
  if (typeof window === "undefined") return;
  if (!/^(entity|doc|team|secret):/.test(id)) return;
  try {
    const next = [id, ...readRecentCommandIds().filter((x) => x !== id)].slice(0, MAX_RECENTS);
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    /* best-effort */
  }
}
