// The v4 hierarchy folds (orun-work-v4 WH1) — the TypeScript mirror of the
// Go oracle (orun `internal/worklens/intent.go` + `rollup.go`). Replays
// fixtures/hierarchy-conformance.json byte-identically; do not change one
// side without the other.
//
// Intent state is a fold over COORDINATION EVENTS ONLY; rollups are folds
// OVER the delivery fold's output. Nothing here is stored, nothing here is
// editable (V4-3/V4-4), and the delivery fold itself is untouched (V4-1).
// Drift is re-derived from the log — the ladder and doc revision at the
// approval's position vs now — never trusted from a payload.

import {
  healthIndex,
  type Actor,
  type CoordinationEvent,
  type FoldResult,
  type Health,
  type IntentState,
  type Milestone,
  type Rung,
  type Spec,
  type Task,
  type WorkSet,
} from "./model.js";

// ── Canonical JSON + content id (matches the Go canonicalizer) ──────────────

function appendCanonical(v: unknown): string {
  if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return `[${v.map(appendCanonical).join(",")}]`;
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${appendCanonical(obj[k])}`).join(",")}}`;
}

export function canonicalJson(v: unknown): string {
  return appendCanonical(v);
}

export async function contentId(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(v));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(hash)) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** Digests a milestone ladder canonically — MUST match the Go LadderHash:
 *  the Go struct marshals key/title/ordinal always, and goal/doneWhen/
 *  targetDate only when non-empty (omitempty). */
export async function ladderHash(ms: Milestone[]): Promise<string> {
  const shaped = ms.map((m) => {
    const o: Record<string, unknown> = { key: m.key, title: m.title, ordinal: m.ordinal };
    if (m.goal) o.goal = m.goal;
    if (m.doneWhen && m.doneWhen.length > 0) o.doneWhen = m.doneWhen;
    if (m.targetDate) o.targetDate = m.targetDate;
    return o;
  });
  return contentId(shaped);
}

// ── The milestone ladder fold ────────────────────────────────────────────────

export interface MilestonePayload {
  op: "create" | "edit" | "reorder" | "remove";
  key: string;
  title?: string | undefined;
  goal?: string | undefined;
  doneWhen?: string[] | undefined;
  targetDate?: string | undefined;
  ordinal?: number | undefined;
}

interface LadderState {
  byKey: Map<string, Milestone>;
  dead: Set<string>;
  created: number;
}

function newLadder(): LadderState {
  return { byKey: new Map(), dead: new Set(), created: 0 };
}

function applyMilestoneFields(m: Milestone, p: MilestonePayload): void {
  if (p.title !== undefined) m.title = p.title;
  if (p.goal !== undefined) m.goal = p.goal || undefined;
  if (p.doneWhen !== undefined) m.doneWhen = p.doneWhen.length > 0 ? [...p.doneWhen] : undefined;
  if (p.targetDate !== undefined) m.targetDate = p.targetDate || undefined;
  if (p.ordinal !== undefined) m.ordinal = p.ordinal;
}

function applyLadderOp(l: LadderState, p: MilestonePayload): void {
  switch (p.op) {
    case "create": {
      if (l.byKey.has(p.key) && !l.dead.has(p.key)) return; // keys immutable; duplicate create is a no-op
      const m: Milestone = { key: p.key, title: "", ordinal: l.created };
      applyMilestoneFields(m, p);
      l.byKey.set(p.key, m);
      l.dead.delete(p.key);
      l.created++;
      break;
    }
    case "edit":
    case "reorder": {
      const m = l.byKey.get(p.key);
      if (!m || l.dead.has(p.key)) return;
      applyMilestoneFields(m, p);
      break;
    }
    case "remove": {
      if (l.byKey.has(p.key)) l.dead.add(p.key);
      break;
    }
  }
}

function ladderMilestones(l: LadderState): Milestone[] {
  const out: Milestone[] = [];
  for (const [k, m] of l.byKey) {
    if (!l.dead.has(k)) out.push({ ...m });
  }
  out.sort((a, b) => (a.ordinal !== b.ordinal ? a.ordinal - b.ordinal : a.key < b.key ? -1 : 1));
  return out;
}

function milestoneOf(e: CoordinationEvent): MilestonePayload | undefined {
  if (e.kind !== "milestone_edited") return undefined;
  const p = (e.payload ?? {}) as Partial<MilestonePayload>;
  if (!p.op || !p.key) return undefined;
  return p as MilestonePayload;
}

/** Derives an epic's current milestone ladder from its milestone_edited
 *  events (log order; non-epic subjects ignored). */
export function foldMilestones(epicKey: string, events: CoordinationEvent[]): Milestone[] {
  const l = newLadder();
  for (const e of events) {
    if (e.subject !== epicKey) continue;
    const p = milestoneOf(e);
    if (p) applyLadderOp(l, p);
  }
  return ladderMilestones(l);
}

// ── The intent-ladder fold ───────────────────────────────────────────────────

export interface Approval {
  revision?: string | undefined; // doc revision named by the approved event
  snapshot?: string | undefined; // sealed EpicSnapshot content id
  by: Actor;
  at?: string | undefined;
  ladderHash?: string | undefined; // milestone-ladder digest at approval
}

export interface EpicIntent {
  key: string;
  state: IntentState;
  approval?: Approval | undefined;
  currentRevision?: string | undefined;
  currentLadderHash?: string | undefined;
  docDrifted?: boolean | undefined;
  ladderDrifted?: boolean | undefined;
  milestones?: Milestone[] | undefined;
}

export interface DesignIntent {
  key: string;
  state: IntentState;
  adoptedRevision?: string | undefined;
  minted?: string[] | undefined;
  adoptedBy?: Actor | undefined;
  supersededBy?: string | undefined;
}

/** Derives an epic's intent state from its coordination events (log order).
 *  Task churn is invisible by construction (task events carry task subjects)
 *  — V4-5: tasks are regenerable; the doc + ladder are the approved scope. */
export async function foldEpicIntent(epicKey: string, events: CoordinationEvent[]): Promise<EpicIntent> {
  const ladder = newLadder();
  let docRev = "";
  let approval: Approval | undefined;
  let lastDecision = 0;
  let lastReview = 0;
  let canceled = false;

  for (const e of events) {
    if (e.subject !== epicKey) continue;
    switch (e.kind) {
      case "milestone_edited": {
        const p = milestoneOf(e);
        if (p) applyLadderOp(ladder, p);
        break;
      }
      case "doc_edited": {
        const p = (e.payload ?? {}) as { revision?: string };
        if (p.revision) docRev = p.revision;
        break;
      }
      case "review_requested":
        lastReview = e.seq;
        break;
      case "approved": {
        const p = (e.payload ?? {}) as { revision?: string; snapshot?: string };
        approval = {
          revision: p.revision || docRev || undefined,
          snapshot: p.snapshot || undefined,
          by: e.actor,
          at: e.at,
          ladderHash: await ladderHash(ladderMilestones(ladder)),
        };
        lastDecision = e.seq;
        break;
      }
      case "approval_revoked":
        approval = undefined;
        lastDecision = e.seq;
        break;
      case "canceled":
        canceled = true;
        break;
      default:
        break;
    }
  }

  const milestones = ladderMilestones(ladder);
  const currentLadderHash = await ladderHash(milestones);
  const out: EpicIntent = {
    key: epicKey,
    state: "draft",
    currentRevision: docRev || undefined,
    currentLadderHash,
    milestones: milestones.length > 0 ? milestones : undefined,
  };

  if (canceled) {
    out.state = "canceled";
  } else if (approval) {
    out.approval = approval;
    out.docDrifted = (approval.revision ?? "") !== docRev;
    out.ladderDrifted = approval.ladderHash !== undefined && approval.ladderHash !== currentLadderHash;
    out.state = out.docDrifted || out.ladderDrifted ? "approved_drifted" : "approved";
  } else if (lastReview > lastDecision) {
    out.state = "in_review";
  }
  return out;
}

/** Derives a design's intent state. Adoption freezes its record (V4-4): a
 *  later supersede changes the state but never erases what was adopted. */
export function foldDesignIntent(designKey: string, events: CoordinationEvent[]): DesignIntent {
  const out: DesignIntent = { key: designKey, state: "draft" };
  let inReview = false;
  let adopted = false;
  let superseded = false;
  let canceled = false;
  for (const e of events) {
    if (e.subject !== designKey) continue;
    switch (e.kind) {
      case "review_requested":
        inReview = true;
        break;
      case "design_adopted": {
        const p = (e.payload ?? {}) as { revision?: string; minted?: string[] };
        adopted = true;
        out.adoptedRevision = p.revision || undefined;
        out.minted = p.minted;
        out.adoptedBy = e.actor;
        break;
      }
      case "superseded": {
        const p = (e.payload ?? {}) as { by?: string };
        superseded = true;
        out.supersededBy = p.by || undefined;
        break;
      }
      case "canceled":
        canceled = true;
        break;
      default:
        break;
    }
  }
  if (canceled) out.state = "canceled";
  else if (superseded) out.state = "superseded";
  else if (adopted) out.state = "adopted";
  else if (inReview) out.state = "in_review";
  return out;
}

// ── Rollup folds (derived, never stored, never editable — V4-4) ─────────────

export interface MilestoneProgress {
  key?: string | undefined; // "" / undefined = the unscheduled bucket
  counts: Partial<Record<Rung, number>>;
  total: number;
  complete: number; // done + released
  blocked: number;
}

export interface EpicExecution {
  key: string;
  milestones?: MilestoneProgress[] | undefined; // ladder order
  unscheduled?: MilestoneProgress | undefined;
  totals: Partial<Record<Rung, number>>;
  total: number;
  complete: number;
  blocked: number;
}

export interface HealthPin {
  health: Health;
  by: Actor;
  note?: string | undefined;
  at?: string | undefined;
}

export interface InitiativeStatus {
  key: string;
  health: Health;
  evidence?: string[] | undefined;
  pinned?: HealthPin | undefined;
  progress: Partial<Record<Rung, number>>;
  total: number;
  complete: number;
  epics: number;
}

/** One epic's envelope + its two folds — what one pyramid level hands the
 *  next. */
export interface EpicRollup {
  epic: Spec;
  intent: Pick<EpicIntent, "state">;
  execution: Pick<EpicExecution, "totals" | "total" | "complete" | "blocked">;
}

function newProgress(key?: string): MilestoneProgress {
  return { key: key || undefined, counts: {}, total: 0, complete: 0, blocked: 0 };
}

function addToProgress(p: MilestoneProgress, rung: Rung, blocked: boolean): void {
  p.counts[rung] = (p.counts[rung] ?? 0) + 1;
  p.total++;
  if (rung === "done" || rung === "released") p.complete++;
  if (blocked) p.blocked++;
}

/** Rolls an epic's tasks up its milestone ladder. Tasks naming a milestone
 *  absent from the ladder count into the unscheduled bucket rather than
 *  vanishing (unresolved references degrade visibly — invariant 8). */
export function foldEpicExecution(ws: WorkSet, epicKey: string, ladder: Milestone[], fr: FoldResult): EpicExecution {
  const out: EpicExecution = { key: epicKey, totals: {}, total: 0, complete: 0, blocked: 0 };
  const byKey = new Map<string, MilestoneProgress>();
  for (const m of ladder) byKey.set(m.key, newProgress(m.key));
  const unscheduled = newProgress();

  const sorted = [...ws.tasks].sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const t of sorted) {
    if (t.spec !== epicKey) continue;
    const lc = fr.lifecycles[t.key];
    const rung: Rung = lc?.rung ?? "draft";
    const blocked = lc?.blocked ?? false;
    const bucket = (t.milestone && byKey.get(t.milestone)) || unscheduled;
    addToProgress(bucket, rung, blocked);
    out.totals[rung] = (out.totals[rung] ?? 0) + 1;
    out.total++;
    if (rung === "done" || rung === "released") out.complete++;
    if (blocked) out.blocked++;
  }

  if (ladder.length > 0) out.milestones = ladder.map((m) => byKey.get(m.key)!);
  if (unscheduled.total > 0) out.unscheduled = unscheduled;
  return out;
}

/** Derives an initiative's health from its member epics' folds — the v1
 *  formula (Q-7: locked against the dogfood corpus in WH6). Deterministic by
 *  construction: time enters only through asOf, never through a clock.
 *  Mirrors the Go FoldInitiativeStatus exactly. */
export function foldInitiativeStatus(
  key: string,
  epics: EpicRollup[],
  events: CoordinationEvent[],
  asOf: string,
): InitiativeStatus {
  const out: InitiativeStatus = { key, health: "on_track", progress: {}, total: 0, complete: 0, epics: 0 };

  const ordered = [...epics].sort((a, b) => (a.epic.key < b.epic.key ? -1 : 1));
  const atRisk: string[] = [];
  const offTrack: string[] = [];
  for (const er of ordered) {
    out.epics++;
    for (const [r, n] of Object.entries(er.execution.totals)) {
      const rung = r as Rung;
      out.progress[rung] = (out.progress[rung] ?? 0) + (n ?? 0);
    }
    out.total += er.execution.total;
    out.complete += er.execution.complete;

    if (er.intent.state === "approved_drifted") {
      atRisk.push(`approval drifted on ${er.epic.key}`);
    }
    if (er.execution.blocked > 0) {
      atRisk.push(`${er.execution.blocked} blocked task(s) in ${er.epic.key}`);
    }
    const target = er.epic.targetDate;
    if (target && asOf && target < asOf.slice(0, 10)) {
      if (er.execution.total > 0 && er.execution.complete < er.execution.total) {
        offTrack.push(`${er.epic.key} past target ${target} (${er.execution.complete}/${er.execution.total} complete)`);
      } else if (er.execution.total === 0) {
        atRisk.push(`${er.epic.key} past target ${target} with no tasks`);
      }
    }
  }

  if (offTrack.length > 0) {
    out.health = "off_track";
    out.evidence = [...offTrack, ...atRisk];
  } else if (atRisk.length > 0) {
    out.health = "at_risk";
    out.evidence = atRisk;
  } else if (out.total > 0) {
    out.evidence = [`${out.complete}/${out.total} tasks complete across ${out.epics} epic(s)`];
  }

  // Pin-beside-health: the last pinned event on the initiative subject whose
  // rung parses as a health value; expires when derived health catches up.
  let pin: HealthPin | undefined;
  for (const e of events) {
    if (e.subject !== key || e.kind !== "pinned") continue;
    const p = (e.payload ?? {}) as { rung?: string; note?: string };
    if (!p.rung) {
      pin = undefined;
      continue;
    }
    const h = p.rung as Health;
    if (healthIndex(h) === undefined) continue;
    pin = { health: h, by: e.actor, note: p.note, at: e.at };
  }
  if (pin) {
    const di = healthIndex(out.health)!;
    const pi = healthIndex(pin.health)!;
    if (di < pi) out.pinned = pin;
  }
  return out;
}

// ── Sealing: the frozen brief approval mints (WH4, design §3) ───────────────
//
// EpicSnapshot ⊇ SpecSnapshot: the epic envelope + the milestone ladder +
// ladderHash + task envelopes with contracts (informative context — task
// churn never drifts approval, V4-5) + the approval record + log cursors.
// Canonical JSON, content-addressed; the approve mutator seals it IN THE
// SAME TRANSACTION as the approved event and stamps the id into the payload.
// `orun epic pull` verifies sha256(bytes) == id — one artifact, no second
// canonicalizer to drift (V4-6).

export interface EpicSnapshotApproval {
  revision?: string | undefined; // the doc revision approved
  by: Actor;
  at?: string | undefined;
  ladderHash?: string | undefined;
}

export interface EpicSnapshot {
  kind: "EpicSnapshot";
  apiVersion: string;
  spec: Spec;
  milestones: Milestone[];
  tasks: Task[];
  ladderHash: string;
  design?: string | undefined; // adopted design revision, when minted from one
  approval: EpicSnapshotApproval;
  catalog?: string | undefined;
  coordSeq: number;
  obsSeq: number;
}

/** Tokens that must never appear in sealed bytes: the intent plane cannot
 *  carry fold output (v2 invariant 1, extended to v4 seals). */
const HOT_STATE_TOKENS = ['"rung"', '"lifecycle"', '"assignees"', '"pinned"'];

export interface SealedEpicSnapshot {
  id: string; // 'sha256:<hex>' over the canonical bytes
  canonical: string; // the exact bytes the id hashes
  snapshot: EpicSnapshot;
}

function intentOnlyTask(t: Task): Task {
  // The envelope is intent by construction; rebuild it field-by-field so a
  // future envelope addition cannot silently smuggle state into the seal.
  const out: Task = {
    apiVersion: t.apiVersion,
    kind: t.kind,
    key: t.key,
    workspace: t.workspace,
    title: t.title,
    createdBy: t.createdBy,
  };
  if (t.spec) out.spec = t.spec;
  if (t.milestone) out.milestone = t.milestone;
  if (t.labels) out.labels = t.labels;
  if (t.contract) out.contract = t.contract;
  if (t.createdAt) out.createdAt = t.createdAt;
  return out;
}

/** Builds and seals the frozen brief. Tasks are ordered by key so identical
 *  inputs seal byte-identically regardless of input order. */
export async function sealEpicSnapshot(input: {
  spec: Spec;
  milestones: Milestone[];
  tasks: Task[];
  approval: EpicSnapshotApproval;
  design?: string | undefined;
  catalog?: string | undefined;
  coordSeq: number;
  obsSeq: number;
}): Promise<SealedEpicSnapshot> {
  const spec: Spec = { ...input.spec };
  delete (spec as { id?: string }).id; // row ids are environment-local, not content
  const tasks = [...input.tasks].map(intentOnlyTask).sort((a, b) => (a.key < b.key ? -1 : 1));
  for (const t of tasks) delete (t as { id?: string }).id;
  const snapshot: EpicSnapshot = {
    kind: "EpicSnapshot",
    apiVersion: spec.apiVersion,
    spec,
    milestones: input.milestones,
    tasks,
    ladderHash: await ladderHash(input.milestones),
    design: input.design,
    approval: input.approval,
    catalog: input.catalog,
    coordSeq: input.coordSeq,
    obsSeq: input.obsSeq,
  };
  const canonical = canonicalJson(snapshot);
  for (const token of HOT_STATE_TOKENS) {
    if (canonical.includes(token)) {
      throw new Error(`worklens: snapshot carries hot state (${token}) — invariant 1`);
    }
  }
  const bytes = new TextEncoder().encode(canonical);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  let hex = "";
  for (const b of new Uint8Array(hash)) hex += b.toString(16).padStart(2, "0");
  return { id: `sha256:${hex}`, canonical, snapshot };
}
