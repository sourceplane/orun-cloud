// In-memory WorkRepository — the two-log design taken literally: the only
// state is the two append-only logs; envelopes derive on every read via
// buildEnvelopes. It is both the test double and the executable proof that
// no read needs anything but the logs (invariant 1 by construction).

import { canonicalDocBody, docDigest } from "./doc.js";
import { buildEnvelopes, type ItemCreatedPayload } from "./envelopes.js";
import {
  WorkError,
  validateActor,
  validateEvent,
  validateObservation,
  type CoordinationEvent,
  type DocRevision,
  type Observation,
  type WorkSet,
} from "./model.js";
import type {
  AssignInput,
  CancelInput,
  CommentInput,
  CommitOutcome,
  CreateInitiativeInput,
  CreateSpecInput,
  CreateTaskInput,
  EditContractInput,
  EditItemInput,
  IngestObservationInput,
  IngestOutcome,
  OrderInput,
  PinInput,
  PutDocInput,
  PutDocOutcome,
  WorkRepository,
  WorkspaceScope,
} from "./types.js";

const PREFIX_RE = /^[A-Z]{2,5}$/;
const SLUG_RE = /^[a-z0-9-]+$/;

interface LogPair {
  events: CoordinationEvent[];
  observations: Observation[];
  dedupe: Set<string>;
  sequences: Map<string, number>;
  /** Document bodies by digest — content beside the logs, not envelope
   *  state (the log carries only the doc_edited digest pointers). */
  docRevisions: Map<string, DocRevision>;
}

export class MemoryWorkRepository implements WorkRepository {
  private readonly workspaces = new Map<string, LogPair>();
  private idCounter = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  private logs(scope: WorkspaceScope): LogPair {
    let pair = this.workspaces.get(scope.orgId);
    if (!pair) {
      pair = { events: [], observations: [], dedupe: new Set(), sequences: new Map(), docRevisions: new Map() };
      this.workspaces.set(scope.orgId, pair);
    }
    return pair;
  }

  private nextSeq(pair: LogPair, name: string): number {
    const next = (pair.sequences.get(name) ?? 0) + 1;
    pair.sequences.set(name, next);
    return next;
  }

  private append(
    scope: WorkspaceScope,
    partial: Omit<CoordinationEvent, "eventId" | "workspace" | "seq">,
  ): CoordinationEvent {
    const pair = this.logs(scope);
    const event: CoordinationEvent = {
      ...partial,
      eventId: `mem-ev-${++this.idCounter}`,
      workspace: scope.orgId,
      seq: this.nextSeq(pair, "#events"),
    };
    validateEvent(event);
    pair.events.push(event);
    return event;
  }

  private exists(scope: WorkspaceScope, key: string): boolean {
    const { specs, tasks, initiatives } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    return specs.some((s) => s.key === key) || tasks.some((t) => t.key === key) || initiatives.some((i) => i.key === key);
  }

  async createSpec(scope: WorkspaceScope, input: CreateSpecInput) {
    validateActor(input.actor);
    if (!SLUG_RE.test(input.slug)) {
      throw new WorkError("invalid", `spec slug ${input.slug} must be lowercase kebab`);
    }
    if (this.exists(scope, input.slug)) {
      throw new WorkError("conflict", `spec ${input.slug} already exists`);
    }
    const payload: ItemCreatedPayload = {
      kind: "Spec",
      key: input.slug,
      title: input.title,
      docRef: input.docRef,
      labels: input.labels,
    };
    const event = this.append(scope, {
      subject: input.slug,
      kind: "item_created",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: payload as unknown as Record<string, unknown>,
    });
    const { specs } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    const spec = specs.find((s) => s.key === input.slug);
    if (!spec) throw new WorkError("invalid", "spec did not materialize from its own event");
    return { event, key: input.slug, spec };
  }

  async createInitiative(scope: WorkspaceScope, input: CreateInitiativeInput) {
    validateActor(input.actor);
    if (!SLUG_RE.test(input.slug)) {
      throw new WorkError("invalid", `initiative slug ${input.slug} must be lowercase kebab`);
    }
    if (this.exists(scope, input.slug)) {
      throw new WorkError("conflict", `item ${input.slug} already exists`);
    }
    const payload: ItemCreatedPayload = {
      kind: "Initiative",
      key: input.slug,
      title: input.title,
      description: input.description,
    };
    const event = this.append(scope, {
      subject: input.slug,
      kind: "item_created",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: payload as unknown as Record<string, unknown>,
    });
    const { initiatives } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    const initiative = initiatives.find((i) => i.key === input.slug);
    if (!initiative) throw new WorkError("invalid", "initiative did not materialize from its own event");
    return { event, key: input.slug, initiative };
  }

  async createTask(scope: WorkspaceScope, input: CreateTaskInput) {
    validateActor(input.actor);
    if (!PREFIX_RE.test(input.prefix)) {
      throw new WorkError("invalid", `prefix ${input.prefix} must be 2–5 uppercase letters`);
    }
    if (input.specKey && !this.exists(scope, input.specKey)) {
      throw new WorkError("not_found", `spec ${input.specKey} does not exist`);
    }
    const pair = this.logs(scope);
    const key = `${input.prefix}-${this.nextSeq(pair, input.prefix)}`;
    const payload: ItemCreatedPayload = {
      kind: "Task",
      key,
      title: input.title,
      specKey: input.specKey,
      labels: input.labels,
      contract: input.contract,
    };
    const event = this.append(scope, {
      subject: key,
      kind: "item_created",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: payload as unknown as Record<string, unknown>,
    });
    const { tasks } = buildEnvelopes(scope.orgId, pair.events);
    const task = tasks.find((t) => t.key === key);
    if (!task) throw new WorkError("invalid", "task did not materialize from its own event");
    return { event, key, task };
  }

  private mustExist(scope: WorkspaceScope, key: string): void {
    if (!this.exists(scope, key)) {
      throw new WorkError("not_found", `unknown item ${key}`);
    }
  }

  async editItem(scope: WorkspaceScope, input: EditItemInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    this.mustExist(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind: "item_edited",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { title: input.title, labels: input.labels, docRef: input.docRef },
    });
    return { event, key: input.key };
  }

  async editContract(scope: WorkspaceScope, input: EditContractInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    this.mustExist(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind: "contract_edited",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { contract: input.contract },
    });
    return { event, key: input.key };
  }

  async assign(scope: WorkspaceScope, input: AssignInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "assigned", input.actor, input.at, { subjectId: input.subject });
  }

  async unassign(scope: WorkspaceScope, input: AssignInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "unassigned", input.actor, input.at, { subjectId: input.subject });
  }

  async comment(scope: WorkspaceScope, input: CommentInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "comment_added", input.actor, input.at, { body: input.body });
  }

  async order(scope: WorkspaceScope, input: OrderInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "ordered", input.actor, input.at, { view: input.view, order: input.order });
  }

  async pin(scope: WorkspaceScope, input: PinInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "pinned", input.actor, input.at, {
      rung: input.rung ?? undefined,
      note: input.note,
    });
  }

  async cancel(scope: WorkspaceScope, input: CancelInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "canceled", input.actor, input.at, {});
  }

  private simpleEvent(
    scope: WorkspaceScope,
    key: string,
    kind: CoordinationEvent["kind"],
    actor: CoordinationEvent["actor"],
    at: string | undefined,
    payload: Record<string, unknown>,
  ): CommitOutcome {
    validateActor(actor);
    this.mustExist(scope, key);
    const event = this.append(scope, { subject: key, kind, actor, at: at ?? this.now(), payload });
    return { event, key };
  }

  async putDocRevision(scope: WorkspaceScope, input: PutDocInput): Promise<PutDocOutcome> {
    validateActor(input.actor);
    const pair = this.logs(scope);
    const { specs } = buildEnvelopes(scope.orgId, pair.events);
    const spec = specs.find((s) => s.key === input.specKey);
    if (!spec) {
      throw new WorkError("not_found", `unknown spec ${input.specKey}`);
    }
    const body = canonicalDocBody(input.body);
    const revision = await docDigest(body);
    if (revision === spec.docRef) {
      return { revision, parent: spec.docRef, created: false, event: null };
    }
    const parent = input.parent ?? spec.docRef;
    const at = input.at ?? this.now();
    if (!pair.docRevisions.has(revision)) {
      pair.docRevisions.set(revision, {
        revision,
        parent,
        specKey: input.specKey,
        body,
        createdBy: input.actor,
        createdAt: at,
      });
    }
    const event = this.append(scope, {
      subject: input.specKey,
      kind: "doc_edited",
      actor: input.actor,
      at,
      payload: { revision, parent },
    });
    return { revision, parent, created: true, event };
  }

  async getDocRevision(scope: WorkspaceScope, specKey: string, revision?: string): Promise<DocRevision> {
    const pair = this.logs(scope);
    let target = revision;
    if (!target) {
      const { specs } = buildEnvelopes(scope.orgId, pair.events);
      const spec = specs.find((s) => s.key === specKey);
      if (!spec) throw new WorkError("not_found", `unknown spec ${specKey}`);
      if (!spec.docRef) throw new WorkError("not_found", `spec ${specKey} has no document`);
      target = spec.docRef;
    }
    const rev = pair.docRevisions.get(target);
    if (!rev || rev.specKey !== specKey) {
      // An imported doc_ref points at a repo body the cloud never stored —
      // the caller renders "imported from repo @ digest" (design §6).
      throw new WorkError("not_found", `no cloud revision ${target} for spec ${specKey}`);
    }
    return rev;
  }

  async listDocHistory(scope: WorkspaceScope, specKey: string): Promise<Omit<DocRevision, "body">[]> {
    const pair = this.logs(scope);
    if (!this.exists(scope, specKey)) {
      throw new WorkError("not_found", `unknown spec ${specKey}`);
    }
    return [...pair.docRevisions.values()]
      .filter((r) => r.specKey === specKey)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.revision < b.revision ? -1 : 1))
      .map(({ body: _body, ...rest }) => rest);
  }

  async ingestObservation(scope: WorkspaceScope, input: IngestObservationInput): Promise<IngestOutcome> {
    const pair = this.logs(scope);
    const probe: Observation = { ...input, seq: 0 };
    validateObservation(probe);
    if (pair.dedupe.has(input.dedupeKey)) {
      return { observation: null, deduped: true }; // same fact twice ⇒ same fold
    }
    const observation: Observation = {
      ...input,
      obsId: `mem-obs-${++this.idCounter}`,
      seq: this.nextSeq(pair, "#observations"),
    };
    pair.dedupe.add(input.dedupeKey);
    pair.observations.push(observation);
    return { observation, deduped: false };
  }

  async getWorkSet(scope: WorkspaceScope): Promise<WorkSet> {
    const pair = this.logs(scope);
    const { tasks } = buildEnvelopes(scope.orgId, pair.events);
    return { tasks, events: [...pair.events], observations: [...pair.observations] };
  }

  async listEvents(scope: WorkspaceScope, fromSeq = 0): Promise<CoordinationEvent[]> {
    return this.logs(scope).events.filter((e) => e.seq > fromSeq);
  }

  async listObservations(scope: WorkspaceScope, fromSeq = 0): Promise<Observation[]> {
    return this.logs(scope).observations.filter((o) => o.seq > fromSeq);
  }

  /** Test hook: the envelopes derived from nothing but the log. */
  envelopes(scope: WorkspaceScope) {
    return buildEnvelopes(scope.orgId, this.logs(scope).events);
  }
}
