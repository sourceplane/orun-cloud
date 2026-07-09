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

/** Replays item_created / item_edited / contract_edited into the current
 *  envelopes. Events must be seq-ordered; unknown subjects in edits are a
 *  replay integrity error (the mutator checked existence at write time). */
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
      default:
        // assigned/unassigned/comment_added/ordered/pinned/canceled — and
        // the v3 conversation/intent kinds (reactions, labels, priority,
        // estimates, relations, cycles) — carry coordination state the fold
        // (or a later milestone's envelope columns, PM2) reads from the log
        // directly; none of them touch the v2 envelope fields.
        break;
    }
  }

  return {
    specs: [...specs.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    tasks: [...tasks.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    initiatives: [...initiatives.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
  };
}
