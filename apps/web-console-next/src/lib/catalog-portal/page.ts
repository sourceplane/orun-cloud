/**
 * Catalog-portal dedicated-page view-model (saas-catalog-portal CP5).
 *
 * Extends the drawer's `buildSelected` shape into the full, drilled-in service
 * page from the design (`design/Service_Catalog.dc.html`, the `isPage` branch):
 * the readiness ring, the entity's REAL doc set (saas-catalog-docs CD4 — the
 * git-authored overview + pages read from the org doc index and rendered by
 * digest), and an honest provenance activity feed.
 *
 * The honesty rule (saas-catalog-docs design.md §4, normative): computed
 * content never carries a file name, file icon, or `.md` suffix; git-authored
 * content always carries its provenance line. The synthesized README/
 * ARCHITECTURE/RUNBOOK/API "documents" of CP5 are gone — what remains derived
 * is ONE visibly-badged card (`derivedBlocks`) composed strictly from catalog
 * facts (description · deps · language · system · owner · lifecycle), and the
 * activity feed keeps surfacing only provenance events. Runtime-gated sections
 * (the ops strip) still degrade through the inherited `hasOps` path.
 *
 * Pure and dependency-free, so the page and its unit tests share one mapping.
 */

import { parseEntityRef } from "../catalog-entity-key";
import { ACTIVITY_ICON, iconForKind } from "./icons";
import { parseMarkdown, type MdBlock } from "./markdown";
import { HEALTH } from "./palette";
import {
  buildSelected,
  healthOf,
  isResource,
  lifecycleKey,
  ownerLabel,
  type CatalogContext,
  type CatalogService,
  type SelectedService,
} from "./model";

const RING_R_LG = 32;
const RING_CIRC_LG = 2 * Math.PI * RING_R_LG;

/** One provenance activity event on the dedicated page timeline. */
export interface ActivityEvent {
  id: string;
  iconD: string;
  color: string;
  bg: string;
  title: string;
  meta: string;
}

/** A neighbour reference that navigates to another entity's page. */
export interface PageRef {
  key: string | null;
  name: string;
  iconD: string;
  healthColor: string;
}

export interface ServicePage extends SelectedService {
  /** Large readiness ring geometry (Scorecard tab + ops strip). */
  ringCircLg: string;
  ringOffsetLg: string;
  /** The badged derived card (facts only — never presented as a file); the
   *  fallback body when the entity has no git-authored docs (CD4). */
  derivedBlocks: MdBlock[];
  /** Honest provenance activity feed. */
  activity: ActivityEvent[];
  /** Dependency neighbours, as page-navigable refs. */
  dependsOnRefs: PageRef[];
  usedByRefs: PageRef[];
}

/** Short display name for a dependency ref (resolves through the graph). */
function refName(ref: string, ctx: CatalogContext): string {
  const svc = ctx.byRef.get(ref);
  if (svc) return svc.name;
  return parseEntityRef(ref).name || ref;
}

// ── The derived card (facts only; visibly badged, never a "file") ──

/**
 * The derived-card markdown: strictly real catalog facts — description,
 * dependencies (from relations), language/system/owner/lifecycle, and the real
 * CLI commands to explore the entity. No invented endpoints, runbooks, or
 * architecture prose (those were CP5's synthesized docs — removed by CD4; the
 * real ones are git-authored via docs.pages).
 */
function derivedFacts(s: CatalogService, ctx: CatalogContext): string {
  const owner = s.owner ? ownerLabel(s.owner) : null;
  const L: string[] = [];
  if (s.description && s.description.trim()) L.push(s.description.trim(), "");
  L.push("## At a glance", "");
  L.push(`- **System** — ${s.system}`);
  L.push(`- **Language** — ${s.language ?? "_unspecified_"}`);
  L.push(`- **Owner** — ${owner ?? "_unowned_"}`);
  if (s.lifecycle) L.push(`- **Lifecycle** — ${s.lifecycle}`);
  L.push("", "## Dependencies", "");
  if (s.deps.length) s.deps.forEach((d) => L.push(`- \`${refName(d, ctx)}\``));
  else L.push("- None declared");
  L.push(
    "",
    "## Explore locally",
    "",
    "~~~",
    "orun catalog refresh",
    `orun catalog describe ${s.name}`,
    `orun catalog docs ${s.name} --list`,
    "~~~",
  );
  return L.join("\n");
}

/** The derived-card blocks for an entity (the no-docs fallback body). */
export function derivedBlocksFor(s: CatalogService, ctx: CatalogContext): MdBlock[] {
  return parseMarkdown(derivedFacts(s, ctx));
}

// ── Activity (honest provenance feed) ────────────────────────────

function shortCommit(commit: string): string {
  const clean = commit.replace(/^sha\d*:/i, "");
  return clean.length > 9 ? clean.slice(0, 9) : clean;
}

/**
 * Provenance-derived activity. We surface only events with a real source: the
 * snapshot reconciliation, the resolved git commit, and a declared deprecation.
 * Deploy / incident / PR events stay out until a runtime source exists (never
 * fabricated), matching the design's graceful-degradation contract.
 */
export function activityFor(s: CatalogService): ActivityEvent[] {
  const mk = (id: string, kind: string, title: string, meta: string): ActivityEvent => {
    const a = ACTIVITY_ICON[kind]!;
    return { id, iconD: a.d, color: a.c, bg: `${a.c}1f`, title, meta };
  };
  const events: ActivityEvent[] = [
    mk("reconciled", "check", "Catalog snapshot reconciled", `orun state · ${s.system}`),
  ];
  if (s.sourceCommit) {
    events.push(mk("synced", "commit", "Definition synced from repo", `commit ${shortCommit(s.sourceCommit)}`));
  }
  if (lifecycleKey(s.lifecycle) === "deprecated") {
    events.push(mk("deprecated", "incident", "Marked deprecated in the component source", "lifecycle"));
  }
  return events;
}

// ── Page assembly ────────────────────────────────────────────────

export function buildPage(s: CatalogService, ctx: CatalogContext): ServicePage {
  const sel = buildSelected(s, ctx);
  const score = sel.score ?? 0;
  const usedBy = ctx.usedBy.get(s.entityRef) ?? [];
  return {
    ...sel,
    ringCircLg: RING_CIRC_LG.toFixed(1),
    ringOffsetLg: (RING_CIRC_LG * (1 - score / 100)).toFixed(1),
    derivedBlocks: derivedBlocksFor(s, ctx),
    activity: activityFor(s),
    dependsOnRefs: s.deps.map((ref) => pageRef(ref, ctx)),
    usedByRefs: usedBy.map((u) => pageRef(u.entityRef, ctx)),
  };
}

function pageRef(ref: string, ctx: CatalogContext): PageRef {
  const svc = ctx.byRef.get(ref);
  if (!svc) {
    const { kind, name } = parseEntityRef(ref);
    return { key: null, name: name || ref, iconD: iconForKind(kind), healthColor: "hsl(var(--muted-foreground) / 0.45)" };
  }
  const hk = isResource(svc) ? "managed" : healthOf(svc);
  return { key: svc.key, name: svc.name, iconD: iconForKind(svc.kind), healthColor: HEALTH[hk].c };
}
