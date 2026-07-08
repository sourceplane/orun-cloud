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
  /**
   * teams-ownership TO2 — the read-time resolved owning team, when the git owner
   * string resolves (by handle or alias). Undefined until resolution runs; null
   * when the owner is declared-but-unmapped or absent.
   */
  ownerTeam?: { teamId: string; name: string; handle: string | null } | null;
  /** Resolution state: owned | unmapped (declared, no team) | unowned (no owner). */
  ownerState?: "owned" | "unmapped" | "unowned";
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
  /** Whether the entity has ANY attached git-authored doc (from the org doc
   *  index, saas-catalog-docs); null/undefined = index not loaded. */
  hasDocs?: boolean | null;
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

/** teams-ownership TO2 — one owner string's read-time resolution. */
export interface OwnerResolution {
  owner: string;
  state: "owned" | "unmapped" | "unowned";
  teamId?: string;
  handle?: string | null;
  name?: string;
  avatar?: string | null;
}

/**
 * Stamp each service with its resolved owning team (teams-ownership TO2), from a
 * batch resolution keyed by the raw owner string. Returns new service objects; a
 * service whose owner did not resolve gets `ownerTeam: null` and the resolution's
 * state (`unmapped` | `unowned`).
 */
export function annotateOwnership(
  services: CatalogService[],
  byOwner: Map<string, OwnerResolution>,
): CatalogService[] {
  return services.map((s) => {
    const r = s.owner != null ? byOwner.get(s.owner) : undefined;
    if (!r) return { ...s, ownerTeam: null, ownerState: s.owner ? "unmapped" : "unowned" };
    if (r.state === "owned" && r.teamId && r.name != null) {
      return { ...s, ownerTeam: { teamId: r.teamId, name: r.name, handle: r.handle ?? null }, ownerState: "owned" };
    }
    return { ...s, ownerTeam: null, ownerState: r.state };
  });
}

/**
 * The display label for a service's owner (teams-ownership TO2): the resolved team
 * name when owned, else a legible unmapped/unowned label distinct from each other.
 */
export function resolvedOwnerLabel(s: CatalogService): string {
  if (s.ownerTeam) return s.ownerTeam.name;
  if (s.ownerState === "unmapped" && s.owner) return `Unmapped: ${ownerLabel(s.owner)}`;
  if (s.ownerState === undefined && s.owner) return ownerLabel(s.owner);
  return "Unowned";
}

/**
 * teams-ownership TO5 — ownership coverage over a set of (resolved) services:
 * per-team owned counts, the unmapped-owner backlog (the action list), and the
 * account-level coverage %. This is the data the TH team page + TG access review
 * render — computed once here. Only entities carrying a resolution
 * (`ownerState` set) are counted; call after {@link annotateOwnership}.
 */
export interface OwnershipCoverage {
  total: number;
  owned: number;
  unmapped: number;
  unowned: number;
  /** owned / total, 0–100 (0 when there are no entities). */
  coveragePct: number;
  /** Per-team owned counts, most-owned first. */
  perTeam: Array<{ teamId: string; name: string; count: number }>;
  /** Distinct declared-but-unmapped owner strings + how many entities each. */
  unmappedOwners: Array<{ owner: string; count: number }>;
}

export function ownershipCoverage(services: CatalogService[]): OwnershipCoverage {
  let owned = 0;
  let unmapped = 0;
  let unowned = 0;
  const perTeam = new Map<string, { name: string; count: number }>();
  const unmappedOwners = new Map<string, number>();
  for (const s of services) {
    if (s.ownerTeam && s.ownerState === "owned") {
      owned++;
      const e = perTeam.get(s.ownerTeam.teamId);
      if (e) e.count++;
      else perTeam.set(s.ownerTeam.teamId, { name: s.ownerTeam.name, count: 1 });
    } else if (s.ownerState === "unmapped") {
      unmapped++;
      if (s.owner) unmappedOwners.set(s.owner, (unmappedOwners.get(s.owner) ?? 0) + 1);
    } else {
      unowned++;
    }
  }
  const total = services.length;
  return {
    total,
    owned,
    unmapped,
    unowned,
    coveragePct: total ? Math.round((owned / total) * 100) : 0,
    perTeam: [...perTeam.entries()]
      .map(([teamId, v]) => ({ teamId, name: v.name, count: v.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    unmappedOwners: [...unmappedOwners.entries()]
      .map(([owner, count]) => ({ owner, count }))
      .sort((a, b) => b.count - a.count || a.owner.localeCompare(b.owner)),
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

export type CheckStatus = "pass" | "warn" | "fail" | "unknown";
export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  /** Remediation copy shown on a failing check (teams-ownership TO4). */
  detail?: string;
}

/**
 * Evaluate the eight readiness checks against the signals we actually have.
 * A check is `fail` only when a hard signal is provably absent (no owner, no
 * docs), `pass` when a real positive signal exists, `warn` when a wired
 * signal is in a degraded-but-known state, and `unknown` when the signal has
 * no source at all — never a false `pass`, and (scorecard v2) never a score
 * penalty for a signal nobody can produce yet: `unknown` checks are excluded
 * from the score denominator, and Gold additionally requires ≥5 known checks
 * (the coverage floor) so a two-signal entity can't coast to the top tier.
 */
export function computeChecks(s: CatalogService): CheckResult[] {
  return CHECKS.map(({ id, label }) => {
    const status = checkStatus(id, s);
    const detail = checkDetail(id, s);
    return detail ? { id, label, status, detail } : { id, label, status };
  });
}

/**
 * teams-ownership TO4 — remediation copy for a failing check, distinguishing an
 * owner declared-but-unmapped (add an alias) from no owner declared at all.
 */
function checkDetail(id: string, s: CatalogService): string | undefined {
  if (id !== "owner") return undefined;
  if (s.ownerState === "unmapped") {
    return `Owner “${ownerLabel(s.owner)}” isn’t mapped to a team — set the team’s handle to match, or add an owner alias.`;
  }
  if (s.ownerState === "unowned" || (s.ownerState === undefined && !s.owner)) {
    return "No owner declared in git (add an `owner:` to the entity).";
  }
  return undefined;
}

function checkStatus(id: string, s: CatalogService): CheckStatus {
  switch (id) {
    case "owner":
      // teams-ownership TO4 — ownership is honest only when the git owner
      // resolves to a real team. Unmapped or unowned both fail (with distinct
      // remediation above). Before resolution runs (ownerState undefined), fall
      // back to "a string is present" so the score doesn't flicker.
      if (s.ownerState === undefined) return s.owner ? "pass" : "fail";
      return s.ownerState === "owned" ? "pass" : "fail";
    case "docs":
      // Real git-authored docs (the org doc index) win; a declared description
      // still counts as the minimum bar; both provably absent → fail.
      if (s.hasDocs === true) return "pass";
      return s.description && s.description.trim() ? "pass" : "fail";
    case "oncall":
      // No on-call source is wired yet — unknown, never a score penalty.
      return s.onCall ? "pass" : "unknown";
    case "slo":
      if (s.slo == null || s.sloTarget == null) return "unknown";
      return s.slo >= s.sloTarget ? "pass" : "fail";
    case "runbook":
      // Wired from the org doc index (saas-catalog-docs): a runbook-role doc
      // attached in git. false = docs are indexed and none is a runbook.
      return s.hasRunbook == null ? "unknown" : s.hasRunbook ? "pass" : "fail";
    case "tests":
      // Wired from the runs feed: the project's latest terminal orun run.
      return s.testsPassing == null ? "unknown" : s.testsPassing ? "pass" : "fail";
    case "vulns":
      return s.criticalVulns == null ? "unknown" : s.criticalVulns === 0 ? "pass" : "fail";
    case "pipeline":
      // Wired from the runs feed: deploys happen via orun runs. A known
      // pipeline with zero recent runs is a real warn, not unknown.
      if (s.deploysPerWeek == null) return "unknown";
      return s.deploysPerWeek > 0 ? "pass" : "warn";
    default:
      return "unknown";
  }
}

// Readiness scoring runs the 8-check scorecard and is hit on every sort
// comparison, every decoration, and the metric rollup. The inputs are the
// service's own immutable fields, so memoize per service object (PERF C3):
// `toServices` produces stable objects, so the cache survives filter / sort /
// selection / typing re-renders and the scorecard is computed once per entity.
export interface Scorecard {
  /** 0–100 over the KNOWN checks only, or null (resource / nothing known). */
  score: number | null;
  /** How many of the eight checks had a real signal (the coverage). */
  known: number;
}

const scorecardCache = new WeakMap<CatalogService, Scorecard>();

/** The unknown-aware scorecard (v2): score over known checks + coverage. */
export function scorecardOf(s: CatalogService): Scorecard {
  const cached = scorecardCache.get(s);
  if (cached !== undefined) return cached;
  const v = computeScorecard(s);
  scorecardCache.set(s, v);
  return v;
}

/** 0–100 readiness score, or null for resources (which are not scored). */
export function scoreOf(s: CatalogService): number | null {
  return scorecardOf(s).score;
}

function computeScorecard(s: CatalogService): Scorecard {
  if (isResource(s)) return { score: null, known: 0 };
  const checks = computeChecks(s);
  const known = checks.filter((c) => c.status !== "unknown");
  if (known.length === 0) return { score: null, known: 0 };
  const v = known.reduce((a, c) => a + (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0), 0);
  return { score: Math.round((v / known.length) * 100), known: known.length };
}

/** Gold requires this many KNOWN checks — the coverage floor that stops a
 *  two-signal entity from coasting to the top tier on unknowns. */
export const GOLD_COVERAGE_FLOOR = 5;

/** Maturity tier from a score (Gold ≥85 · Silver ≥70 · Bronze), or null.
 *  Gold additionally requires the coverage floor; a Gold-score entity below
 *  it caps at Silver until more signals are wired. */
export function tierOf(score: number | null, known?: number): TierKey | null {
  if (score == null) return null;
  if (score >= 85) return known === undefined || known >= GOLD_COVERAGE_FLOOR ? "Gold" : "Silver";
  return score >= 70 ? "Silver" : "Bronze";
}

/** Non-resource AND (unhealthy OR unowned) — the design's attention rule. */
export function needsAttention(s: CatalogService): boolean {
  if (isResource(s)) return false;
  const h = healthOf(s);
  return h === "degraded" || h === "down" || !s.owner;
}

/**
 * Stamp each service with its doc-index signals (saas-catalog-docs / SC5):
 * hasDocs (any attached git-authored doc) and hasRunbook (a runbook-role doc).
 * Only called once the org doc index has loaded, so false is a REAL negative
 * ("docs are indexed and none is a runbook"), never an unknown.
 */
export function annotateDocSignals(
  services: CatalogService[],
  docs: Array<{ entityRef: string; role: string }>,
): CatalogService[] {
  const byRef = new Map<string, { any: boolean; runbook: boolean }>();
  for (const d of docs) {
    const cur = byRef.get(d.entityRef) ?? { any: false, runbook: false };
    cur.any = true;
    if (d.role === "runbook") cur.runbook = true;
    byRef.set(d.entityRef, cur);
  }
  return services.map((s) => {
    const hit = byRef.get(s.entityRef);
    return { ...s, hasDocs: !!hit, hasRunbook: hit?.runbook ?? false };
  });
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stamp each service with its runs-feed signals: testsPassing (the source
 * project's latest terminal orun run succeeded — the platform's own CI verdict)
 * and deploysPerWeek (that project's runs in the last 7 days — deploys happen
 * via orun runs, so the pipeline check reads the real pipeline). A project
 * with no runs at all keeps both signals unknown (never a false negative from
 * a feed that simply hasn't seen the project).
 */
export function annotateRunSignals(
  services: CatalogService[],
  runs: Array<{ projectId: string; status: string; createdAt: string }>,
  nowMs: number,
): CatalogService[] {
  const byProject = new Map<string, { latestTerminal: string | null; lastWeek: number }>();
  for (const r of runs) {
    const cur = byProject.get(r.projectId) ?? { latestTerminal: null, lastWeek: 0 };
    // The feed arrives newest-first; keep the first terminal status we see.
    if (cur.latestTerminal === null && (r.status === "succeeded" || r.status === "failed")) {
      cur.latestTerminal = r.status;
    }
    if (nowMs - Date.parse(r.createdAt) <= WEEK_MS) cur.lastWeek++;
    byProject.set(r.projectId, cur);
  }
  return services.map((s) => {
    const hit = byProject.get(s.sourceProjectId);
    if (!hit) return s;
    return {
      ...s,
      testsPassing: hit.latestTerminal == null ? null : hit.latestTerminal === "succeeded",
      deploysPerWeek: hit.lastWeek,
    };
  });
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
  const { score, known } = scorecardOf(s);
  const tier = tierOf(score, known);
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
    // teams-ownership TO2 — prefer the resolved team identity when available;
    // fall back to the raw owner label before resolution runs.
    ownerName: s.ownerTeam ? s.ownerTeam.name : resolvedOwnerLabel(s),
    ownerInitials: ownerInitials(s.ownerTeam ? s.ownerTeam.name : s.owner),
    owned: s.ownerState ? s.ownerState === "owned" : !!s.owner,
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
  // teams-ownership TO5 — count RESOLVED ownership (a real team), falling back to
  // "a string is present" before resolution runs.
  const owned = services.filter((s) => (s.ownerState ? s.ownerState === "owned" : !!s.owner)).length;
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
  unknownCount: number;
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
  const unknown = checks.filter((c) => c.status === "unknown").length;
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
    unknownCount: unknown,
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
