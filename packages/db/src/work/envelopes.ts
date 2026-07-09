// Envelope replay: rebuild the intent-envelope caches (work.specs /
// work.tasks rows) from the coordination log alone — the droppable-cache
// guarantee (invariant 1). Both repositories share this fold: the in-memory
// repository derives envelopes on every read; the SQL repository uses it to
// prove (and repair) its cache rows.

import {
  API_VERSION,
  WorkError,
  type Contract,
  type CoordinationEvent,
  type Initiative,
  type Priority,
  type Relation,
  type RelationKind,
  type Spec,
  type Task,
} from "./model.js";

export interface ItemCreatedPayload {
  kind: "Spec" | "Task" | "Initiative";
  key: string;
  title: string;
  description?: string | undefined; // initiatives only
  specKey?: string | undefined;
  docRef?: string | undefined;
  labels?: Record<string, string> | undefined;
  contract?: Contract | undefined;
}

export interface ItemEditedPayload {
  title?: string | undefined;
  description?: string | undefined;
  labels?: Record<string, string> | undefined;
  docRef?: string | undefined;
}

export interface DocEditedPayload {
  revision: string;
  parent?: string | undefined;
}

export interface ContractEditedPayload {
  contract: Contract;
}

export interface Envelopes {
  specs: Spec[];
  tasks: Task[];
  initiatives: Initiative[];
}

function mustTask(tasks: Map<string, Task>, e: CoordinationEvent): Task {
  const task = tasks.get(e.subject);
  if (!task) {
    throw new WorkError("not_found", `replay: ${e.kind} on unknown task ${e.subject} at seq ${e.seq}`);
  }
  return task;
}

/** Replays item_created / item_edited / contract_edited — plus the v3 PM2
 *  board-intent kinds — into the current envelopes. Events must be
 *  seq-ordered; unknown subjects in edits are a replay integrity error (the
 *  mutator checked existence at write time). */
export function buildEnvelopes(workspace: string, events: CoordinationEvent[]): Envelopes {
  const specs = new Map<string, Spec>();
  const tasks = new Map<string, Task>();
  const initiatives = new Map<string, Initiative>();

  for (const e of events) {
    switch (e.kind) {
      case "item_created": {
        const p = e.payload as unknown as ItemCreatedPayload;
        if (p.kind === "Initiative") {
          initiatives.set(p.key, {
            apiVersion: API_VERSION,
            kind: "Initiative",
            key: p.key,
            workspace,
            title: p.title,
            description: p.description,
            createdBy: e.actor,
            createdAt: e.at,
          });
        } else if (p.kind === "Spec") {
          specs.set(p.key, {
            apiVersion: API_VERSION,
            kind: "Spec",
            key: p.key,
            workspace,
            title: p.title,
            docRef: p.docRef,
            labels: p.labels,
            createdBy: e.actor,
            createdAt: e.at,
          });
        } else {
          tasks.set(p.key, {
            apiVersion: API_VERSION,
            kind: "Task",
            key: p.key,
            workspace,
            spec: p.specKey,
            title: p.title,
            labels: p.labels,
            contract: p.contract,
            createdBy: e.actor,
            createdAt: e.at,
          });
        }
        break;
      }
      case "item_edited": {
        const p = e.payload as unknown as ItemEditedPayload;
        const spec = specs.get(e.subject);
        const task = tasks.get(e.subject);
        const initiative = initiatives.get(e.subject);
        if (!spec && !task && !initiative) {
          throw new WorkError("not_found", `replay: edit of unknown item ${e.subject} at seq ${e.seq}`);
        }
        if (initiative) {
          if (p.title !== undefined) initiative.title = p.title;
          if (p.description !== undefined) initiative.description = p.description;
        }
        if (spec) {
          if (p.title !== undefined) spec.title = p.title;
          if (p.labels !== undefined) spec.labels = p.labels;
          if (p.docRef !== undefined) spec.docRef = p.docRef;
        }
        if (task) {
          if (p.title !== undefined) task.title = p.title;
          if (p.labels !== undefined) task.labels = p.labels;
        }
        break;
      }
      case "contract_edited": {
        const p = e.payload as unknown as ContractEditedPayload;
        const task = tasks.get(e.subject);
        if (!task) {
          throw new WorkError("not_found", `replay: contract edit of unknown task ${e.subject} at seq ${e.seq}`);
        }
        task.contract = p.contract;
        break;
      }
      case "doc_edited": {
        // The cloud document pointer IS envelope state: replaying the log
        // must reproduce work.specs.doc_ref (invariant 1). Bodies live in
        // work.doc_revisions — content, not envelope.
        const p = e.payload as unknown as DocEditedPayload;
        const spec = specs.get(e.subject);
        if (!spec) {
          throw new WorkError("not_found", `replay: doc edit of unknown spec ${e.subject} at seq ${e.seq}`);
        }
        spec.docRef = p.revision;
        break;
      }
      // ── Board intent (v3 PM2): folded envelope fields on tasks ──────────
      // These are task verbs at the mutator; an unknown task subject is a
      // replay integrity error, same as item_edited.
      case "labeled":
      case "unlabeled": {
        const p = e.payload as unknown as { label?: string };
        const task = mustTask(tasks, e);
        if (!p.label) break;
        const tags = new Set(task.tags ?? []);
        if (e.kind === "labeled") tags.add(p.label);
        else tags.delete(p.label);
        task.tags = tags.size > 0 ? [...tags].sort() : undefined;
        break;
      }
      case "prioritized": {
        const p = e.payload as unknown as { priority?: Priority };
        const task = mustTask(tasks, e);
        task.priority = p.priority && p.priority !== "none" ? p.priority : undefined;
        break;
      }
      case "estimated": {
        const p = e.payload as unknown as { points?: number | null };
        const task = mustTask(tasks, e);
        task.estimate = typeof p.points === "number" ? p.points : undefined;
        break;
      }
      case "cycle_set": {
        // v3 PM3: plan a task into (or out of) a time-box. Assignment is
        // intent; the burn-up inside the cycle stays derived (V3-3).
        const p = e.payload as unknown as { cycle?: string | null };
        const task = mustTask(tasks, e);
        task.cycleKey = p.cycle ?? undefined;
        break;
      }
      case "related":
      case "unrelated": {
        // Relations fold onto TASK envelopes only; spec/initiative subjects
        // (initiative membership) stay log-derived until the PM3 rollups.
        const p = e.payload as unknown as { rel?: RelationKind; target?: string };
        const task = tasks.get(e.subject);
        if (!task || !p.rel || !p.target) break;
        const rels = (task.relations ?? []).filter((r) => !(r.rel === p.rel && r.target === p.target));
        const rel: Relation = { rel: p.rel, target: p.target };
        if (e.kind === "related") rels.push(rel);
        task.relations = rels.length > 0 ? rels : undefined;
        break;
      }
      default:
        // assigned/unassigned/comment_added/ordered/pinned/canceled — and
        // the v3 conversation kinds (reactions, doc anchors) — carry
        // coordination state the fold reads from the log directly; none of
        // them touch the envelope fields.
        break;
    }
  }

  return {
    specs: [...specs.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    tasks: [...tasks.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    initiatives: [...initiatives.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}

/** Replays related/unrelated into the current relation set per subject —
 *  for ANY item kind (v3 PM3 uses it for initiative→spec `parent` edges;
 *  task relations additionally fold onto the task envelope above). */
export function foldRelations(events: CoordinationEvent[]): Map<string, Relation[]> {
  const out = new Map<string, Relation[]>();
  for (const e of events) {
    if (e.kind !== "related" && e.kind !== "unrelated") continue;
    const p = e.payload as unknown as { rel?: RelationKind; target?: string };
    if (!p.rel || !p.target) continue;
    const rels = (out.get(e.subject) ?? []).filter((r) => !(r.rel === p.rel && r.target === p.target));
    if (e.kind === "related") rels.push({ rel: p.rel, target: p.target });
    if (rels.length > 0) out.set(e.subject, rels);
    else out.delete(e.subject);
  }
  return out;
}
