// The work lens (orun-work v2) — pure model + the fold.
//
// This module mirrors orun's `internal/worklens` package, which is the
// conformance ORACLE: both folds replay fixtures/conformance.json (the files
// are byte-identical across the two repos) and must produce identical
// results. Do not change fold semantics here without changing the oracle.
//
// The design rule this module embodies (specs/orun-work/design.md):
// lifecycle is a DERIVED QUERY over two append-only logs — coordination
// (what people intend) and observation (what the world did) — never a
// stored column. Nothing in this file writes anything.

export const API_VERSION = "orun.io/v1";

// ── Closed vocabularies ─────────────────────────────────────────────────────

export const KINDS = ["Spec", "Task"] as const;
export type Kind = (typeof KINDS)[number];

export const RUNGS = [
  "draft",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "released",
  "canceled",
] as const;
export type Rung = (typeof RUNGS)[number];

/** Ladder positions for pin-expiry comparison; canceled is off-ladder. */
const RUNG_ORDER: Partial<Record<Rung, number>> = {
  draft: 0,
  ready: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
  released: 5,
};

export function rungIndex(r: Rung): number | undefined {
  return RUNG_ORDER[r];
}

/** The 9-kind coordination vocabulary. There is deliberately NO lifecycle
 *  write kind — the category "someone asserts a rung" is unrepresentable. */
export const EVENT_KINDS = [
  "item_created",
  "item_edited",
  "contract_edited",
  "assigned",
  "unassigned",
  "comment_added",
  "ordered",
  "pinned",
  "canceled",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const OBSERVATION_KINDS = [
  "branch_seen",
  "pr_opened",
  "pr_merged",
  "pr_closed",
  "gate_result",
  "revision_live",
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export const ACTOR_TYPES = ["user", "agent", "automation"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const GATE_STATUSES = ["green", "red", "pending"] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface Actor {
  type: ActorType;
  id: string;
  via?: string | undefined; // console | mcp | cli | import
}

export interface Contract {
  goal?: string | undefined;
  affects?: string[] | undefined;
  doneWhen?: string[] | undefined;
  gates?: string[] | undefined;
  designRefs?: string[] | undefined;
  deps?: string[] | undefined;
  /** Distinguishes an explicit empty gate set (merge alone may reach Done —
   *  P-7) from gates never having been declared (merge parks In Review). */
  gatesDefined?: boolean | undefined;
}

export interface Spec {
  apiVersion: string;
  kind: "Spec";
  id?: string | undefined;
  key: string;
  workspace: string;
  title: string;
  docRef?: string | undefined;
  labels?: Record<string, string> | undefined;
  createdBy: Actor;
  createdAt?: string | undefined;
}

export interface Task {
  apiVersion: string;
  kind: "Task";
  id?: string | undefined;
  key: string;
  workspace: string;
  spec?: string | undefined;
  title: string;
  labels?: Record<string, string> | undefined;
  contract?: Contract | undefined;
  createdBy: Actor;
  createdAt?: string | undefined;
}

export interface CoordinationEvent {
  eventId?: string | undefined;
  workspace: string;
  subject: string;
  kind: EventKind;
  actor: Actor;
  at: string;
  payload?: Record<string, unknown> | undefined;
  seq: number;
}

export interface Observation {
  obsId?: string | undefined;
  workspace: string;
  source: string;
  sourceVersion: number;
  kind: ObservationKind;
  at: string;
  dedupeKey: string;
  payload?: Record<string, unknown> | undefined;
  seq: number;
}

export interface Pin {
  rung: Rung;
  by: Actor;
  note?: string | undefined;
  at?: string | undefined;
}

export interface Lifecycle {
  key: string;
  rung: Rung;
  pinned?: Pin | undefined;
  ready: boolean;
  blocked: boolean;
  evidence?: string[] | undefined;
}

export interface DriftItem {
  pr: string;
  affected: string[];
}

export interface Suggestion {
  pr: string;
  taskKeys: string[];
}

export interface WorkSet {
  tasks: Task[];
  events: CoordinationEvent[];
  observations: Observation[];
}

export interface FoldResult {
  lifecycles: Record<string, Lifecycle>;
  drift?: DriftItem[] | undefined;
  suggestions?: Suggestion[] | undefined;
}

// ── Validation (write-time rules; the mutator's front door) ─────────────────

export class WorkError extends Error {
  constructor(
    readonly code:
      | "unknown_kind"
      | "missing_actor"
      | "missing_subject"
      | "agent_pin"
      | "bad_observation"
      | "not_found"
      | "conflict"
      | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "WorkError";
  }
}

export function validateActor(a: Actor | undefined | null): void {
  if (!a || !ACTOR_TYPES.includes(a.type) || !a.id) {
    throw new WorkError("missing_actor", "every coordination event needs a typed actor (invariant 3)");
  }
}

export function validateEvent(e: CoordinationEvent): void {
  if (!EVENT_KINDS.includes(e.kind)) {
    throw new WorkError("unknown_kind", `unknown event kind ${String(e.kind)}`);
  }
  if (!e.subject) {
    throw new WorkError("missing_subject", `event ${e.kind} has no subject`);
  }
  validateActor(e.actor);
  if (e.kind === "pinned" && e.actor.type === "agent") {
    throw new WorkError("agent_pin", `agents may not pin (${e.subject}) — WP-10`);
  }
}

export function validateObservation(o: Observation): void {
  if (!OBSERVATION_KINDS.includes(o.kind)) {
    throw new WorkError("bad_observation", `unknown observation kind ${String(o.kind)}`);
  }
  if (!o.source || !o.sourceVersion || o.sourceVersion < 1) {
    throw new WorkError("bad_observation", `observation ${o.kind} needs a named versioned source (P-2)`);
  }
  if (!o.dedupeKey) {
    throw new WorkError("bad_observation", `observation ${o.kind} from ${o.source} has no dedupeKey (invariant 4)`);
  }
}

export function contractComplete(c: Contract | undefined | null): boolean {
  if (!c) return false;
  const gatesDeclared = c.gatesDefined === true || (c.gates?.length ?? 0) > 0;
  return Boolean(c.goal) && (c.affects?.length ?? 0) > 0 && (c.doneWhen?.length ?? 0) > 0 && gatesDeclared;
}

const TASK_KEY_RE = /^[A-Z]{2,5}-[1-9][0-9]*$/;
const TASK_KEYS_IN_RE = /[A-Z]{2,5}-[1-9][0-9]*/g;

export function isTaskKey(key: string): boolean {
  return TASK_KEY_RE.test(key);
}

/** Extracts distinct task keys from free text (branch names, PR titles) in
 *  order of first appearance — the auto-claim short-circuit. */
export function taskKeysIn(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(TASK_KEYS_IN_RE)) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
  }
  return out;
}

// ── The fold ────────────────────────────────────────────────────────────────

interface PrState {
  id: string;
  firstSeq: number;
  branch: string;
  draft: boolean;
  opened: boolean;
  merged: boolean;
  closed: boolean;
  revision: string;
  taskKeys: string[];
  affected: string[];
  branchOnly: boolean;
}

interface PrPayload {
  pr?: string;
  branch?: string;
  draft?: boolean;
  revision?: string;
  taskKeys?: string[];
  affected?: string[];
}

function mergeKeys(into: string[], add: string[] | undefined): string[] {
  if (!add) return into;
  const seen = new Set(into);
  for (const k of add) {
    if (!seen.has(k)) {
      seen.add(k);
      into.push(k);
    }
  }
  return into;
}

function overlaps(a: string[] | undefined, b: string[]): boolean {
  if (!a) return false;
  const set = new Set(a);
  return b.some((y) => set.has(y));
}

/** Derives lifecycle, drift, and claim suggestions from the two logs.
 *  Pure and deterministic — replays the shared conformance fixtures
 *  identically to the Go oracle. Events/observations must be seq-ordered. */
export function fold(ws: WorkSet): FoldResult {
  const tasks = new Map<string, Task>(ws.tasks.map((t) => [t.key, t]));
  const sortedTasks = [...ws.tasks].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // Pass 1 — coordination: cancellation and active pins, in log order.
  const canceled = new Map<string, Actor>();
  const pins = new Map<string, Pin>();
  for (const e of ws.events) {
    if (e.kind === "canceled") {
      canceled.set(e.subject, e.actor);
    } else if (e.kind === "pinned") {
      const p = (e.payload ?? {}) as { rung?: Rung; note?: string };
      if (!p.rung) {
        pins.delete(e.subject); // explicit unpin
      } else {
        pins.set(e.subject, { rung: p.rung, by: e.actor, note: p.note, at: e.at });
      }
    }
  }

  // Pass 2 — observation: PR trajectories, gate verdicts, live revisions.
  const prs = new Map<string, PrState>();
  const prOf = (id: string, seq: number): PrState => {
    let st = prs.get(id);
    if (!st) {
      st = {
        id,
        firstSeq: seq,
        branch: "",
        draft: false,
        opened: false,
        merged: false,
        closed: false,
        revision: "",
        taskKeys: [],
        affected: [],
        branchOnly: false,
      };
      prs.set(id, st);
    }
    return st;
  };
  const prIdOf = (p: PrPayload): string => p.pr || `branch:${p.branch ?? ""}`;
  const gates = new Map<string, GateStatus>();
  const gateKey = (gate: string, rev: string) => `${gate}@${rev}`;
  const live = new Map<string, string>();

  for (const o of ws.observations) {
    const p = (o.payload ?? {}) as PrPayload & { gate?: string; revision?: string; status?: GateStatus; environment?: string };
    switch (o.kind) {
      case "branch_seen": {
        const st = prOf(prIdOf(p), o.seq);
        st.branch = p.branch ?? "";
        if (!st.opened) st.branchOnly = true;
        mergeKeys(st.taskKeys, p.taskKeys);
        break;
      }
      case "pr_opened": {
        const st = prOf(prIdOf(p), o.seq);
        st.opened = true;
        st.branchOnly = false;
        st.closed = false;
        st.draft = p.draft === true;
        mergeKeys(st.taskKeys, p.taskKeys);
        mergeKeys(st.affected, p.affected);
        break;
      }
      case "pr_merged": {
        const st = prOf(prIdOf(p), o.seq);
        st.merged = true;
        st.branchOnly = false;
        if (p.revision) st.revision = p.revision;
        mergeKeys(st.taskKeys, p.taskKeys);
        mergeKeys(st.affected, p.affected);
        break;
      }
      case "pr_closed": {
        const st = prOf(prIdOf(p), o.seq);
        if (!st.merged) st.closed = true;
        break;
      }
      case "gate_result": {
        if (p.gate && p.revision && p.status) gates.set(gateKey(p.gate, p.revision), p.status);
        break;
      }
      case "revision_live": {
        if (p.revision && !live.has(p.revision)) live.set(p.revision, p.environment ?? "");
        break;
      }
    }
  }

  const orderedPRs = [...prs.values()].sort((a, b) => a.firstSeq - b.firstSeq);

  // Pass 3 — the claim join: key parse wins; overlap claims only when
  // exactly one open task matches; ambiguity suggests, never links (P-6).
  const claims = new Map<string, PrState[]>();
  const suggestions: Suggestion[] = [];
  const openForClaim = (key: string) => tasks.has(key) && !canceled.has(key);
  for (const pr of orderedPRs) {
    let claimed = false;
    for (const k of pr.taskKeys) {
      if (openForClaim(k)) {
        const list = claims.get(k) ?? [];
        list.push(pr);
        claims.set(k, list);
        claimed = true;
      }
    }
    if (claimed || pr.affected.length === 0) continue;
    const matches: string[] = [];
    for (const t of sortedTasks) {
      if (!openForClaim(t.key) || !t.contract) continue;
      if (overlaps(t.contract.affects, pr.affected)) matches.push(t.key);
    }
    if (matches.length === 1) {
      const only = matches[0]!;
      const list = claims.get(only) ?? [];
      list.push(pr);
      claims.set(only, list);
    } else if (matches.length > 1) {
      suggestions.push({ pr: pr.id, taskKeys: matches });
    }
  }

  // observedRung walks the ladder top-down; conservative by construction
  // (invariant 5: unknown-to-orun renders unknown, parks In Review).
  const observedRung = (t: Task): { rung: Rung; evidence?: string[] } => {
    const claiming = claims.get(t.key) ?? [];
    for (const pr of claiming) {
      if (pr.merged && pr.revision) {
        const env = live.get(pr.revision);
        if (env !== undefined) {
          return { rung: "released", evidence: [`revision ${pr.revision} live in ${env} (PR ${pr.id})`] };
        }
      }
    }
    for (const pr of claiming) {
      if (!pr.merged) continue;
      const gatesDeclared = t.contract && (t.contract.gatesDefined === true || (t.contract.gates?.length ?? 0) > 0);
      if (!gatesDeclared) {
        return { rung: "in_review", evidence: [`PR ${pr.id} merged; gates unknown to orun`] };
      }
      for (const g of t.contract?.gates ?? []) {
        const status = gates.get(gateKey(g, pr.revision));
        if (status === undefined) {
          return { rung: "in_review", evidence: [`PR ${pr.id} merged; gate ${g} unknown`] };
        }
        if (status !== "green") {
          return { rung: "in_review", evidence: [`PR ${pr.id} merged; gate ${g} ${status}`] };
        }
      }
      if ((t.contract?.gates?.length ?? 0) === 0) {
        return { rung: "done", evidence: [`PR ${pr.id} merged`] };
      }
      return { rung: "done", evidence: [`PR ${pr.id} merged; gates green`] };
    }
    for (const pr of claiming) {
      if (pr.opened && !pr.merged && !pr.closed && !pr.draft) {
        return { rung: "in_review", evidence: [`PR ${pr.id} open`] };
      }
    }
    for (const pr of claiming) {
      if (pr.opened && !pr.merged && !pr.closed && pr.draft) {
        return { rung: "in_progress", evidence: [`PR ${pr.id} draft`] };
      }
      if (pr.branchOnly) {
        return { rung: "in_progress", evidence: [`branch ${pr.branch} seen`] };
      }
    }
    if (contractComplete(t.contract)) {
      return { rung: "ready", evidence: ["contract complete"] };
    }
    return { rung: "draft" };
  };

  const isBlocked = (t: Task): boolean => {
    if (!t.contract?.deps) return false;
    for (const dep of t.contract.deps) {
      const depTask = tasks.get(dep);
      if (!depTask) continue; // unresolved dep renders elsewhere, never blocks
      if (canceled.has(dep)) continue;
      const { rung } = observedRung(depTask);
      if (rung !== "done" && rung !== "released") return true;
    }
    return false;
  };

  // Pass 4 — per-task lifecycle.
  const lifecycles: Record<string, Lifecycle> = {};
  for (const t of sortedTasks) {
    const cancelActor = canceled.get(t.key);
    if (cancelActor) {
      lifecycles[t.key] = {
        key: t.key,
        rung: "canceled",
        ready: contractComplete(t.contract),
        blocked: false,
        evidence: [`canceled by ${cancelActor.id}`],
      };
      continue;
    }
    const { rung, evidence } = observedRung(t);
    const lc: Lifecycle = {
      key: t.key,
      rung,
      ready: contractComplete(t.contract),
      blocked: isBlocked(t),
      evidence,
    };
    const pin = pins.get(t.key);
    if (pin) {
      const oi = rungIndex(rung);
      const pi = rungIndex(pin.rung);
      if (oi !== undefined && pi !== undefined && oi < pi) {
        lc.pinned = pin; // renders beside observed truth; expires on catch-up
      }
    }
    lifecycles[t.key] = lc;
  }

  // Pass 5 — drift: merged PRs with affected data, no claims, and no open
  // task claiming any of their components.
  const openAffects = new Set<string>();
  for (const t of ws.tasks) {
    const lc = lifecycles[t.key];
    if (!lc || lc.rung === "canceled" || lc.rung === "done" || lc.rung === "released") continue;
    for (const a of t.contract?.affects ?? []) openAffects.add(a);
  }
  const claimedPRs = new Set<PrState>();
  for (const list of claims.values()) for (const pr of list) claimedPRs.add(pr);
  const drift: DriftItem[] = [];
  for (const pr of orderedPRs) {
    if (!pr.merged || pr.affected.length === 0 || claimedPRs.has(pr)) continue;
    if (!pr.affected.some((a) => openAffects.has(a))) {
      drift.push({ pr: pr.id, affected: pr.affected });
    }
  }

  const result: FoldResult = { lifecycles };
  if (drift.length > 0) result.drift = drift;
  if (suggestions.length > 0) result.suggestions = suggestions;
  return result;
}

/** Per-rung counts for one spec's tasks — the projection that replaces
 *  hand-edited status tables (design.md §6.4). */
export function progress(ws: WorkSet, specKey: string, r: FoldResult): Partial<Record<Rung, number>> {
  const counts: Partial<Record<Rung, number>> = {};
  for (const t of ws.tasks) {
    if (t.spec !== specKey) continue;
    const rung = r.lifecycles[t.key]?.rung ?? "draft";
    counts[rung] = (counts[rung] ?? 0) + 1;
  }
  return counts;
}
