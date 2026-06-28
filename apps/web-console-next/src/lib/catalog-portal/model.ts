/**
 * Catalog-portal view-model (saas-catalog-portal CP0).
 *
 * The pure heart of the portal: it maps the platform's `OrgCatalogEntity[]`
 * (plus optional git-authored enrichment and optional runtime signals) into the
 * row / card / node / drawer shapes the design renders, and reproduces the
 * design's scorecard, "needs attention", and metric-rollup logic exactly.
 *
 * Honest by construction: git-derived and computed fields are always present;
 * runtime signals (health/SLO/incidents/deploys) and not-yet-wired readiness
 * checks are *optional* and degrade to "managed" / "—" / `warn` (unknown)
 * rather than being fabricated. Pure and dependency-free, so the table, board,
 * map, drawer, and the unit tests share one mapping.
 */

import type { OrgCatalogEntity } from "@saas/contracts/state";
import { encodeEntityKey, parseEntityRef } from "../catalog-entity-key";
import { HEALTH, LIFE, TIER, type HealthKey, type LifecycleKey, type TierKey } from "./palette";
import { iconForKind } from "./icons";

// ── Normalized service (the portal's input row) ──────────────

/** A catalog entity normalized for the portal: git facts + optional signals. */
export interface CatalogService {
  /** Opaque URL-safe identity key (provenance triple), the React/list key. */
  key: string;
  /** Display name (the entity's short name). */
  name: string;
  /** Stable catalog ref (e.g. `component:default/api`). */
  entityRef: string;
  /** Display ref shown in mono (the entityRef). */
  ref: string;
  /** Kind: Component | API | Resource | System | Domain | Group. */
  kind: string;
  // provenance
  sourceProjectId: string;
  sourceEnvironment: string | null;
  /** Git commit the snapshot was resolved at, when known (activity provenance). */
  sourceCommit: string | null;
  // git-authored
  /** Grouping system; derived from `system`, a System relation, or namespace. */
  system: string;
  /** Owner ref/string, or null when unowned. */
  owner: string | null;
  /** Implementation language, or null. */
  language: string | null;
  /** Raw lifecycle string from the snapshot, or null. */
  lifecycle: string | null;
  /** One-line description, or null. */
  description: string | null;
  /** Dependency target refs (relations, minus the part-of-system edge). */
  deps: string[];
  /** All typed relations (for the map renderer). */
  relations: Array<{ type: string; targetRef: string }>;
  // optional runtime / operational signals (CP4; absent today)
  health?: HealthKey | null;
  slo?: number | null;
  sloTarget?: number | null;
  incidents?: number | null;
  deploysPerWeek?: number | null;
  lastDeployHours?: number | null;
  onCall?: string | null;
  hasRunbook?: boolean | null;
  testsPassing?: boolean | null;
  criticalVulns?: number | null;
}

export function isResource(s: CatalogService): boolean {
  return s.kind.toLowerCase() === "resource";
}

/** Lifecycle string → a canonical key for colour lookup, or null if unknown. */
export function lifecycleKey(lifecycle: string | null | undefined): LifecycleKey | null {
  if (!lifecycle) return null;
  const l = lifecycle.toLowerCase();
  if (/(prod|ga|stable|generally|live)/.test(l)) return "production";
  if (/(deprecat|retir|sunset|eol|end-of-life|legacy)/.test(l)) return "deprecated";
  if (/(experiment|alpha|beta|preview|canary|rc|incubat|wip|draft|dev)/.test(l)) return "experimental";
  return null;
}

/** A service's canonical health key — resources and unknown signals → managed. */
export function healthOf(s: CatalogService): HealthKey {
  if (isResource(s)) return "managed";
  const h = s.health;
  if (h === "healthy" || h === "degraded" || h === "down" || h === "managed") return h;
  return "managed";
}

/** Strip a `kind:ns/name` ref to a human owner label. */
export function ownerLabel(owner: string | null): string {
  if (!owner) return "Unowned";
  if (owner.includes(":") || owner.includes("/")) return parseEntityRef(owner).name || owner;
  return owner;
}

/** Two-letter initials for an owner label (e.g. "ML Platform" → "ML"). */
export function ownerInitials(owner: string | null): string {
  if (!owner) return "?";
  const label = ownerLabel(owner);
  const words = label.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const raw = words.length >= 2 ? words[0]![0]! + words[1]![0]! : label.slice(0, 2);
  return raw.toUpperCase();
}

/** Format a "hours since last deploy" signal the way the design does. */
export function formatDeploy(hours: number | null | undefined): string {
  if (hours == null) return "—";
  if (hours < 1) return Math.round(hours * 60) + "m ago";
  if (hours < 24) return Math.round(hours) + "h ago";
  return Math.round(hours / 24) + "d ago";
}

// ── Mapping OrgCatalogEntity → CatalogService ────────────────

function deriveSystem(e: OrgCatalogEntity): string {
  if (e.system && e.system.trim()) return e.system.trim();
  const sys = e.relations.find((r) => parseEntityRef(r.targetRef).kind === "System");
  if (sys) return parseEntityRef(sys.targetRef).name;
  const ns = parseEntityRef(e.entityRef).namespace;
  return ns && ns !== "default" ? ns : "Ungrouped";
}

/** Map one platform entity into the portal's normalized service shape. */
export function toService(e: OrgCatalogEntity): CatalogService {
  const systemRefs = new Set(
    e.relations.filter((r) => parseEntityRef(r.targetRef).kind === "System").map((r) => r.targetRef),
  );
  return {
    key: encodeEntityKey({
      sourceProjectId: e.sourceProjectId,
      sourceEnvironment: e.sourceEnvironment,
      entityRef: e.entityRef,
    }),
    name: e.name || parseEntityRef(e.entityRef).name,
    entityRef: e.entityRef,
    ref: e.entityRef,
    kind: parseEntityRef(e.entityRef).kind || e.kind,
    sourceProjectId: e.sourceProjectId,
    sourceEnvironment: e.sourceEnvironment,
    sourceCommit: e.sourceCommit ?? null,
    system: deriveSystem(e),
    owner: e.owner,
    language: e.language ?? null,
    lifecycle: e.lifecycle,
    description: e.description ?? null,
    deps: e.relations.filter((r) => !systemRefs.has(r.targetRef)).map((r) => r.targetRef),
    relations: e.relations,
  };
}

/** Map a loaded page of entities into services. */
export function toServices(entities: OrgCatalogEntity[]): CatalogService[] {
  return entities.map(toService);
}

// ── Scorecard engine (design-faithful, honest) ───────────────

export const CHECKS: Array<{ id: string; label: string }> = [
  { id: "owner", label: "Ownership defined" },
  { id: "oncall", label: "On-call configured" },
  { id: "slo", label: "SLO defined" },
  { id: "runbook", label: "Runbook linked" },
  { id: "tests", label: "CI tests passing" },
  { id: "vulns", label: "No critical CVEs" },
  { id: "docs", label: "Docs published" },
  { id: "pipeline", label: "Deploys via pipeline" },
];

export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
}

/**
 * Evaluate the eight readiness checks against the signals we actually have.
 * A check is `fail` only when a hard signal is provably absent (no owner, no
 * docs), `pass` when a real positive signal exists, and `warn` ("unknown")
 * when the signal is not yet wired — never a false `pass`.
 */
export function computeChecks(s: CatalogService): CheckResult[] {
  return CHECKS.map(({ id, label }) => ({ id, label, status: checkStatus(id, s) }));
}

function checkStatus(id: string, s: CatalogService): CheckStatus {
  switch (id) {
    case "owner":
      return s.owner ? "pass" : "fail";
    case "docs":
      return s.description && s.description.trim() ? "pass" : "fail";
    case "oncall":
      return s.onCall ? "pass" : "warn";
    case "slo":
      if (s.slo == null || s.sloTarget == null) return "warn";
      return s.slo >= s.sloTarget ? "pass" : "fail";
    case "runbook":
      return s.hasRunbook == null ? "warn" : s.hasRunbook ? "pass" : "fail";
    case "tests":
      return s.testsPassing == null ? "warn" : s.testsPassing ? "pass" : "fail";
    case "vulns":
      return s.criticalVulns == null ? "warn" : s.criticalVulns === 0 ? "pass" : "fail";
    case "pipeline":
      if (s.deploysPerWeek == null) return "warn";
      return s.deploysPerWeek > 0 ? "pass" : "warn";
    default:
      return "warn";
  }
}

// Readiness scoring runs the 8-check scorecard and is hit on every sort
// comparison, every decoration, and the metric rollup. The inputs are the
// service's own immutable fields, so memoize per service object (PERF C3):
// `toServices` produces stable objects, so the cache survives filter / sort /
// selection / typing re-renders and the scorecard is computed once per entity.
const scoreCache = new WeakMap<CatalogService, number | null>();

/** 0–100 readiness score, or null for resources (which are not scored). */
export function scoreOf(s: CatalogService): number | null {
  const cached = scoreCache.get(s);
  if (cached !== undefined) return cached;
  const v = computeScore(s);
  scoreCache.set(s, v);
  return v;
}

function computeScore(s: CatalogService): number | null {
  if (isResource(s)) return null;
  const checks = computeChecks(s);
  const v = checks.reduce((a, c) => a + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  return Math.round((v / checks.length) * 100);
}

/** Maturity tier from a score (Gold ≥85 · Silver ≥70 · Bronze), or null. */
export function tierOf(score: number | null): TierKey | null {
  if (score == null) return null;
  return score >= 85 ? "Gold" : score >= 70 ? "Silver" : "Bronze";
}

/** Non-resource AND (unhealthy OR unowned) — the design's attention rule. */
export function needsAttention(s: CatalogService): boolean {
  if (isResource(s)) return false;
  const h = healthOf(s);
  return h === "degraded" || h === "down" || !s.owner;
}

// ── Used-by index ────────────────────────────────────────────

export interface CatalogContext {
  services: CatalogService[];
  /** entityRef → services that depend on it. */
  usedBy: Map<string, CatalogService[]>;
  /** entityRef → the service (first wins). */
  byRef: Map<string, CatalogService>;
}

export function buildContext(services: CatalogService[]): CatalogContext {
  const usedBy = new Map<string, CatalogService[]>();
  const byRef = new Map<string, CatalogService>();
  for (const s of services) if (!byRef.has(s.entityRef)) byRef.set(s.entityRef, s);
  for (const s of services) {
    for (const dep of s.deps) {
      const list = usedBy.get(dep) ?? [];
      list.push(s);
      usedBy.set(dep, list);
    }
  }
  return { services, usedBy, byRef };
}

// ── Decoration (row / card shape) ────────────────────────────

export interface DecoratedService {
  key: string;
  name: string;
  ref: string;
  kind: string;
  kindLabel: string;
  iconD: string;
  language: string | null;
  system: string;
  // owner
  ownerName: string;
  ownerInitials: string;
  owned: boolean;
  // lifecycle
  lifeKey: LifecycleKey | null;
  lifeShow: boolean;
  lifeLabel: string;
  lifeColor: string;
  lifeText: string;
  // health
  healthKey: HealthKey;
  healthColor: string;
  healthText: string;
  healthLabel: string;
  healthKnown: boolean;
  // readiness
  hasScore: boolean;
  score: number | null;
  scoreNum: string;
  scorePct: number;
  tier: TierKey | null;
  tierLabel: string;
  tierColor: string;
  tierBg: string;
  tierBorder: string;
  // deps
  depsCount: number;
  usedByCount: number;
  depsLabel: string;
  deployLabel: string;
  svc: CatalogService;
}

export function decorateService(s: CatalogService, ctx: CatalogContext): DecoratedService {
  const res = isResource(s);
  const score = scoreOf(s);
  const tier = tierOf(score);
  const t = tier ? TIER[tier] : null;
  const hk = healthOf(s);
  const h = HEALTH[hk];
  const lk = lifecycleKey(s.lifecycle);
  const life = lk ? LIFE[lk] : null;
  const usedByCount = ctx.usedBy.get(s.entityRef)?.length ?? 0;
  return {
    key: s.key,
    name: s.name,
    ref: s.ref,
    kind: s.kind,
    kindLabel: s.kind,
    iconD: iconForKind(s.kind),
    language: s.language,
    system: s.system,
    ownerName: ownerLabel(s.owner),
    ownerInitials: ownerInitials(s.owner),
    owned: !!s.owner,
    lifeKey: lk,
    lifeShow: !!life,
    lifeLabel: s.lifecycle ?? "",
    lifeColor: life ? life.c : "transparent",
    lifeText: life ? life.t : "hsl(var(--muted-foreground) / 0.45)",
    healthKey: hk,
    healthColor: h.c,
    healthText: h.l,
    healthLabel: h.t,
    healthKnown: !res && (s.health === "healthy" || s.health === "degraded" || s.health === "down"),
    hasScore: score != null,
    score,
    scoreNum: score == null ? "" : String(score),
    scorePct: score ?? 0,
    tier,
    tierLabel: tier ?? "",
    tierColor: t ? t.c : "hsl(var(--muted-foreground) / 0.6)",
    tierBg: t ? t.bg : "transparent",
    tierBorder: t ? t.b : "hsl(var(--input))",
    depsCount: s.deps.length,
    usedByCount,
    depsLabel: `${s.deps.length}/${usedByCount}`,
    deployLabel: formatDeploy(s.lastDeployHours),
    svc: s,
  };
}

// ── Metric rollup (the index tiles) ──────────────────────────

export interface CatalogRollup {
  total: number;
  systems: number;
  owned: number;
  ownedPct: number;
  scored: number;
  ready: number;
  readyPct: number;
  attention: number;
  incidents: number;
  incidentRefs: string[];
}

export function rollup(services: CatalogService[]): CatalogRollup {
  const comps = services.filter((s) => !isResource(s));
  const owned = services.filter((s) => !!s.owner).length;
  const scored = comps.length;
  const ready = comps.filter((s) => (scoreOf(s) ?? 0) >= 70).length;
  const attention = services.filter(needsAttention).length;
  const incidentServices = services.filter((s) => (s.incidents ?? 0) > 0);
  const systems = new Set(services.map((s) => s.system)).size;
  return {
    total: services.length,
    systems,
    owned,
    ownedPct: services.length ? Math.round((owned / services.length) * 100) : 0,
    scored,
    ready,
    readyPct: scored ? Math.round((ready / scored) * 100) : 0,
    attention,
    incidents: incidentServices.reduce((a, s) => a + (s.incidents ?? 0), 0),
    incidentRefs: incidentServices.map((s) => s.name),
  };
}

// ── Drawer view-model ────────────────────────────────────────

export interface MiniRef {
  key: string | null;
  name: string;
  iconD: string;
  healthColor: string;
}

export interface SelectedService extends DecoratedService {
  description: string;
  hasOps: boolean;
  sloCur: number | null;
  sloTarget: number | null;
  sloColor: string;
  incidents: number;
  incColor: string;
  deploysWeek: string;
  passCount: number;
  warnCount: number;
  failCount: number;
  checks: CheckResult[];
  ownerSub: string;
  hasOnCall: boolean;
  onCall: string;
  dependsOn: MiniRef[];
  usedByList: MiniRef[];
  hasDeps: boolean;
  hasUsedBy: boolean;
  noRelations: boolean;
}

function miniOf(ref: string, ctx: CatalogContext): MiniRef {
  const svc = ctx.byRef.get(ref);
  if (!svc) {
    const { kind, name } = parseEntityRef(ref);
    return { key: null, name: name || ref, iconD: iconForKind(kind), healthColor: "hsl(var(--muted-foreground) / 0.45)" };
  }
  const hk = isResource(svc) ? "managed" : healthOf(svc);
  return { key: svc.key, name: svc.name, iconD: iconForKind(svc.kind), healthColor: HEALTH[hk].c };
}

export function buildSelected(s: CatalogService, ctx: CatalogContext): SelectedService {
  const d = decorateService(s, ctx);
  const res = isResource(s);
  const checks = computeChecks(s);
  const pass = checks.filter((c) => c.status === "pass").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  const fail = checks.filter((c) => c.status === "fail").length;
  const sloBreach = !res && s.slo != null && s.sloTarget != null && s.slo < s.sloTarget;
  const usedBy = ctx.usedBy.get(s.entityRef) ?? [];
  return {
    ...d,
    description: s.description ?? "",
    hasOps: !res && (s.slo != null || s.incidents != null || s.deploysPerWeek != null),
    sloCur: s.slo ?? null,
    sloTarget: s.sloTarget ?? null,
    sloColor: sloBreach ? "hsl(var(--destructive))" : "hsl(var(--success))",
    incidents: s.incidents ?? 0,
    incColor: (s.incidents ?? 0) > 0 ? "hsl(var(--destructive))" : "hsl(var(--foreground))",
    deploysWeek: s.deploysPerWeek != null ? `${s.deploysPerWeek}/wk` : "—",
    passCount: pass,
    warnCount: warn,
    failCount: fail,
    checks,
    ownerSub: s.owner ? "team · git-authored" : "no owner declared",
    hasOnCall: !!s.onCall,
    onCall: s.onCall ?? "",
    dependsOn: s.deps.map((r) => miniOf(r, ctx)),
    usedByList: usedBy.map((u) => miniOf(u.entityRef, ctx)),
    hasDeps: s.deps.length > 0,
    hasUsedBy: usedBy.length > 0,
    noRelations: s.deps.length === 0 && usedBy.length === 0,
  };
}
