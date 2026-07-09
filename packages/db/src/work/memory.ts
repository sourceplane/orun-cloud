// In-memory WorkRepository — the two-log design taken literally: the only
// state is the two append-only logs; envelopes derive on every read via
// buildEnvelopes. It is both the test double and the executable proof that
// no read needs anything but the logs (invariant 1 by construction).

import { canonicalDocBody, docDigest } from "./doc.js";
import { buildEnvelopes, type ItemCreatedPayload } from "./envelopes.js";
import {
  PRIORITIES,
  RELATION_KINDS,
  WorkError,
  validateActor,
  validateEvent,
  validateObservation,
  type CoordinationEvent,
  type Cycle,
  type DocRevision,
  type Observation,
  type WorkSet,
} from "./model.js";
import type {
  AssignInput,
  CancelInput,
  CommentInput,
  ReactionInput,
  CommitOutcome,
  CreateCycleInput,
  CreateInitiativeInput,
  CreateSpecInput,
  CreateTaskInput,
  EditContractInput,
  EditItemInput,
  EstimateInput,
  IngestObservationInput,
  IngestOutcome,
  LabelInput,
  OrderInput,
  PinInput,
  PriorityInput,
  PutDocInput,
  PutDocOutcome,
  RelateInput,
  SaveViewInput,
  SetCycleInput,
  WorkRepository,
  WorkspaceScope,
  WorkView,
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
  /** Saved views by key — workspace UI configuration beside the logs
   *  (v3 PM2); no coordination event exists for them. */
  views: Map<string, WorkView>;
  /** Authored time-boxes by key (v3 PM3) — intent rows beside the logs;
   *  planning a task INTO one is the cycle_set coordination event. */
  cycles: Map<string, Cycle>;
}

export class MemoryWorkRepository implements WorkRepository {
  private readonly workspaces = new Map<string, LogPair>();
  private idCounter = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  private logs(scope: WorkspaceScope): LogPair {
    let pair = this.workspaces.get(scope.orgId);
    if (!pair) {
      pair = { events: [], observations: [], dedupe: new Set(), sequences: new Map(), docRevisions: new Map(), views: new Map(), cycles: new Map() };
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
    return this.simpleEvent(scope, input.key, "comment_added", input.actor, input.at, {
      body: input.body,
      parentEvent: input.parentEvent,
      anchor: input.anchor,
    });
  }

  private reaction(scope: WorkspaceScope, kind: "reaction_added" | "reaction_removed", input: ReactionInput): CommitOutcome {
    validateActor(input.actor);
    if (!input.emoji) {
      throw new WorkError("invalid", "a reaction needs an emoji");
    }
    const target = this.logs(scope).events.find((e) => e.eventId === input.targetEvent);
    if (!target || target.kind !== "comment_added") {
      throw new WorkError("not_found", `unknown comment ${input.targetEvent}`);
    }
    const event = this.append(scope, {
      subject: target.subject,
      kind,
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { targetEvent: input.targetEvent, emoji: input.emoji },
    });
    return { event, key: target.subject };
  }

  async addReaction(scope: WorkspaceScope, input: ReactionInput): Promise<CommitOutcome> {
    return this.reaction(scope, "reaction_added", input);
  }

  async removeReaction(scope: WorkspaceScope, input: ReactionInput): Promise<CommitOutcome> {
    return this.reaction(scope, "reaction_removed", input);
  }

  // ── PM2 board intent: task verbs, one event each ──────────────────────────

  private mustBeTask(scope: WorkspaceScope, key: string): void {
    const { tasks } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    if (!tasks.some((t) => t.key === key)) {
      throw new WorkError("not_found", `unknown task ${key}`);
    }
  }

  private labelEvent(scope: WorkspaceScope, kind: "labeled" | "unlabeled", input: LabelInput): CommitOutcome {
    validateActor(input.actor);
    if (!input.label?.trim()) {
      throw new WorkError("invalid", "a label needs a non-empty name");
    }
    this.mustBeTask(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind,
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { label: input.label.trim() },
    });
    return { event, key: input.key };
  }

  async label(scope: WorkspaceScope, input: LabelInput): Promise<CommitOutcome> {
    return this.labelEvent(scope, "labeled", input);
  }

  async unlabel(scope: WorkspaceScope, input: LabelInput): Promise<CommitOutcome> {
    return this.labelEvent(scope, "unlabeled", input);
  }

  async prioritize(scope: WorkspaceScope, input: PriorityInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    if (!PRIORITIES.includes(input.priority)) {
      throw new WorkError("invalid", `priority must be one of ${PRIORITIES.join("|")}`);
    }
    this.mustBeTask(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind: "prioritized",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { priority: input.priority },
    });
    return { event, key: input.key };
  }

  async estimate(scope: WorkspaceScope, input: EstimateInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    if (input.points !== null && (typeof input.points !== "number" || !Number.isFinite(input.points) || input.points < 0)) {
      throw new WorkError("invalid", "estimate points must be a non-negative number (null clears)");
    }
    this.mustBeTask(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind: "estimated",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { points: input.points },
    });
    return { event, key: input.key };
  }

  private relateEvent(scope: WorkspaceScope, kind: "related" | "unrelated", input: RelateInput): CommitOutcome {
    validateActor(input.actor);
    if (!RELATION_KINDS.includes(input.rel)) {
      throw new WorkError("invalid", `rel must be one of ${RELATION_KINDS.join("|")}`);
    }
    if (input.target === input.key) {
      throw new WorkError("invalid", `an item cannot relate to itself (${input.key})`);
    }
    // Relations may join any two items (task↔task, initiative→spec, …).
    this.mustExist(scope, input.key);
    this.mustExist(scope, input.target);
    const event = this.append(scope, {
      subject: input.key,
      kind,
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { rel: input.rel, target: input.target },
    });
    return { event, key: input.key };
  }

  async relate(scope: WorkspaceScope, input: RelateInput): Promise<CommitOutcome> {
    return this.relateEvent(scope, "related", input);
  }

  async unrelate(scope: WorkspaceScope, input: RelateInput): Promise<CommitOutcome> {
    return this.relateEvent(scope, "unrelated", input);
  }

  async setCycle(scope: WorkspaceScope, input: SetCycleInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    this.mustBeTask(scope, input.key);
    if (input.cycle !== null && !this.logs(scope).cycles.has(input.cycle)) {
      throw new WorkError("not_found", `unknown cycle ${input.cycle}`);
    }
    const event = this.append(scope, {
      subject: input.key,
      kind: "cycle_set",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { cycle: input.cycle },
    });
    return { event, key: input.key };
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

  async saveView(scope: WorkspaceScope, input: SaveViewInput): Promise<WorkView> {
    validateActor(input.actor);
    if (!/^[a-z0-9-]+$/.test(input.key)) {
      throw new WorkError("invalid", `view key ${input.key} must be lowercase kebab`);
    }
    if (!input.name?.trim()) {
      throw new WorkError("invalid", "a view needs a name");
    }
    const pair = this.logs(scope);
    const existing = pair.views.get(input.key);
    const view: WorkView = {
      key: input.key,
      name: input.name.trim(),
      config: input.config,
      createdBy: existing?.createdBy ?? input.actor,
      createdAt: existing?.createdAt ?? input.at ?? this.now(),
    };
    pair.views.set(input.key, view);
    return view;
  }

  async listViews(scope: WorkspaceScope): Promise<WorkView[]> {
    return [...this.logs(scope).views.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  async createCycle(scope: WorkspaceScope, input: CreateCycleInput): Promise<Cycle> {
    validateActor(input.actor);
    if (!input.name?.trim()) {
      throw new WorkError("invalid", "a cycle needs a name");
    }
    const starts = Date.parse(input.startsAt);
    const ends = Date.parse(input.endsAt);
    if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends < starts) {
      throw new WorkError("invalid", "a cycle needs startsAt <= endsAt (ISO dates)");
    }
    const pair = this.logs(scope);
    const key = `CYC-${this.nextSeq(pair, "CYC")}`;
    const cycle: Cycle = {
      key,
      name: input.name.trim(),
      startsAt: input.startsAt.slice(0, 10),
      endsAt: input.endsAt.slice(0, 10),
      createdBy: input.actor,
      createdAt: input.at ?? this.now(),
    };
    pair.cycles.set(key, cycle);
    return cycle;
  }

  async listCycles(scope: WorkspaceScope): Promise<Cycle[]> {
    return [...this.logs(scope).cycles.values()].sort((a, b) =>
      a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.key < b.key ? -1 : 1,
    );
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
