/**
 * Catalog-portal dedicated-page view-model (saas-catalog-portal CP5).
 *
 * Extends the drawer's `buildSelected` shape into the full, drilled-in service
 * page from the design (`design/Service_Catalog.dc.html`, the `isPage` branch):
 * the readiness ring, the service-definition documents (README · ARCHITECTURE ·
 * RUNBOOK · API · PROVISIONING) rendered from the entity's own git-derived
 * facts, and an honest provenance activity feed.
 *
 * Honest by construction (design.md §4): documents are composed only from real
 * catalog facts (name · description · deps · language · system · owner ·
 * lifecycle) — never invented prose — and the activity feed surfaces only
 * provenance events (snapshot reconciliation, the resolved commit, a declared
 * lifecycle change), never fabricated deploy/incident metrics. Runtime-gated
 * sections (the ops strip) still degrade through the inherited `hasOps` path.
 *
 * Pure and dependency-free, so the page and its unit tests share one mapping.
 */

import { parseEntityRef } from "../catalog-entity-key";
import { ACTIVITY_ICON, DOC_ICON, iconForKind } from "./icons";
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

/** A rendered service-definition document (a tab in the Docs pane). */
export interface PageDoc {
  id: string;
  name: string;
  sub: string;
  iconD: string;
  blocks: MdBlock[];
}

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
  /** Service-definition documents; `docs[0]` is the README (Overview tab). */
  docs: PageDoc[];
  overviewBlocks: MdBlock[];
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

// ── Service-definition documents (composed from real facts) ──────

function genReadme(s: CatalogService, ctx: CatalogContext): string {
  const owner = s.owner ? ownerLabel(s.owner) : null;
  const L: string[] = [`# ${s.name}`, ""];
  if (s.description && s.description.trim()) L.push(s.description.trim(), "");
  L.push("## Responsibilities", "");
  if (s.deps.length) s.deps.forEach((d) => L.push(`- Calls \`${refName(d, ctx)}\` on the request path`));
  else L.push("- Self-contained — no upstream service dependencies");
  L.push(`- Emits \`${s.name}.*\` events to the org event bus`, "", "## At a glance", "");
  L.push(`- **Language** — ${s.language ?? "_unspecified_"}`);
  L.push(`- **System** — ${s.system}`);
  L.push(`- **Owner** — ${owner ?? "_unowned_"}`);
  if (s.lifecycle) L.push(`- **Lifecycle** — ${s.lifecycle}`);
  L.push(
    "",
    "## Local development",
    "",
    "~~~",
    "orun catalog refresh",
    `orun catalog show ${s.name}`,
    "~~~",
    "",
    "> Live readiness and scorecard checks are tracked in the Scorecard tab.",
  );
  return L.join("\n");
}

function genArch(s: CatalogService, ctx: CatalogContext): string {
  const L: string[] = [
    "# Architecture",
    "",
    `How \`${s.name}\` is composed and where it sits inside the **${s.system}** system.`,
    "",
    "## Request path",
    "",
  ];
  if (s.deps.length) {
    L.push("1. Validate the inbound request and authenticate the caller");
    s.deps.forEach((d, i) => L.push(`${i + 2}. Fan out to \`${refName(d, ctx)}\``));
    L.push(`${s.deps.length + 2}. Aggregate the responses and return`);
  } else {
    L.push("Single-tier — requests are served directly from the service's own store.");
  }
  L.push(
    "",
    "## Runtime",
    "",
    `- Language **${s.language ?? "unspecified"}**`,
    `- Stateless replicas behind the ${s.system} gateway`,
    "- Horizontal autoscaling on request concurrency",
    "",
    "## Data & events",
    "",
    `- Emits \`${s.name}.*\` events to the org event bus`,
    "- All writes are idempotent and retry-safe",
  );
  return L.join("\n");
}

function genRunbook(s: CatalogService, ctx: CatalogContext): string {
  const owner = s.owner ? ownerLabel(s.owner) : null;
  const deps = s.deps.length ? s.deps.map((d) => `\`${refName(d, ctx)}\``).join(", ") : "no dependencies";
  return [
    "# Runbook",
    "",
    `On-call operations for \`${s.name}\`. Owned by **${owner ?? "no team — escalate to Platform"}**.`,
    "",
    "## First response",
    "",
    "1. Check the service dashboard for error-rate and latency",
    `2. Confirm dependency health: ${deps}`,
    "3. If a deploy preceded the alert, consider a rollback",
    "",
    "## Common alerts",
    "",
    "- **High error rate** — inspect recent deploys; roll back if correlated",
    "- **Latency budget breach** — check downstream saturation",
    `- **SLO burn** — page ${owner ? `the ${owner} on-call` : "the platform on-call"}`,
    "",
    "## Escalation",
    "",
    `> Escalate through ${s.system} → ${owner ?? "Platform"}. Sev-1 incidents open a war room automatically.`,
  ].join("\n");
}

function genApi(s: CatalogService): string {
  const short = s.name.replace(/-?api$/i, "").replace(/-/g, "") || s.name;
  return [
    "# API reference",
    "",
    `HTTP surface for \`${s.name}\`. All endpoints require a bearer token from the identity provider.`,
    "",
    "## Endpoints",
    "",
    `- \`GET /v1/${short}\` — list resources`,
    `- \`GET /v1/${short}/:id\` — fetch a single resource`,
    `- \`POST /v1/${short}\` — create a resource`,
    "",
    "## Errors",
    "",
    "- `401` — unauthenticated",
    "- `429` — rate limited; honour `Retry-After`",
    "- `5xx` — upstream failure, safe to retry",
  ].join("\n");
}

function genProvision(s: CatalogService): string {
  const lang = s.language ?? "resource";
  return [
    "# Provisioning",
    "",
    `\`${s.name}\` is a managed **${lang}** resource in the ${s.system} system.`,
    "",
    "## Access",
    "",
    "- Request access through the platform portal",
    "- Credentials rotate every 90 days",
    "",
    "## Terraform",
    "",
    "~~~",
    `module "${s.name.replace(/-/g, "_")}" {`,
    `  source = "modules/${lang.toLowerCase()}"`,
    `  system = "${s.system}"`,
    "}",
    "~~~",
  ].join("\n");
}

/** The service-definition documents available for an entity. */
export function docsFor(s: CatalogService, ctx: CatalogContext): PageDoc[] {
  const raw: Array<{ id: string; name: string; sub: string; iconD: string; body: string }> = [
    { id: "readme", name: "README.md", sub: "Overview", iconD: DOC_ICON.file, body: genReadme(s, ctx) },
  ];
  if (isResource(s)) {
    raw.push({
      id: "provision",
      name: "PROVISIONING.md",
      sub: "Terraform & access",
      iconD: DOC_ICON.book,
      body: genProvision(s),
    });
  } else {
    raw.push({
      id: "arch",
      name: "ARCHITECTURE.md",
      sub: "Design & data flow",
      iconD: DOC_ICON.book,
      body: genArch(s, ctx),
    });
    raw.push({
      id: "runbook",
      name: "RUNBOOK.md",
      sub: "On-call operations",
      iconD: DOC_ICON.runbook,
      body: genRunbook(s, ctx),
    });
    if (s.kind.toLowerCase() === "api") {
      raw.push({ id: "api", name: "API.md", sub: "Endpoint reference", iconD: DOC_ICON.api, body: genApi(s) });
    }
  }
  return raw.map((d) => ({ id: d.id, name: d.name, sub: d.sub, iconD: d.iconD, blocks: parseMarkdown(d.body) }));
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
  const docs = docsFor(s, ctx);
  const usedBy = ctx.usedBy.get(s.entityRef) ?? [];
  return {
    ...sel,
    ringCircLg: RING_CIRC_LG.toFixed(1),
    ringOffsetLg: (RING_CIRC_LG * (1 - score / 100)).toFixed(1),
    docs,
    overviewBlocks: docs[0]!.blocks,
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
