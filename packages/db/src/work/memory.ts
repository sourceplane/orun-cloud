// In-memory WorkRepository — the two-log design taken literally: the only
// state is the two append-only logs; envelopes derive on every read via
// buildEnvelopes. It is both the test double and the executable proof that
// no read needs anything but the logs (invariant 1 by construction).

import { canonicalDocBody, docDigest } from "./doc.js";
import { buildEnvelopes, type ItemCreatedPayload } from "./envelopes.js";
import { foldEpicIntent, foldMilestones, sealEpicSnapshot } from "./hierarchy.js";
import {
  PRIORITIES,
  RELATION_KINDS,
  REVIEW_VERDICTS,
  WorkError,
  fold,
  isMilestoneKey,
  validateActor,
  validateEvent,
  validateObservation,
  validateProposal,
  type CoordinationEvent,
  type Cycle,
  type Design,
  type DocRevision,
  type Milestone,
  type Observation,
  type WorkSet,
} from "./model.js";
import type {
  AdoptDesignInput,
  AdoptOutcome,
  ApproveInput,
  RegenerateOutcome,
  RegenerateTasksInput,
  SealedBrief,
  AssignInput,
  CancelInput,
  CommentInput,
  ReactionInput,
  CommitOutcome,
  CreateCycleInput,
  CreateDesignInput,
  CreateInitiativeInput,
  CreateSpecInput,
  CreateTaskInput,
  EditContractInput,
  EditItemInput,
  EditMilestoneInput,
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
  RequestReviewInput,
  RevokeApprovalInput,
  SaveViewInput,
  SetCycleInput,
  SetMilestoneInput,
  SubmitVerdictInput,
  SupersedeDesignInput,
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
  /** Sealed epic briefs by content id (v4 WH4) — canonical bytes, exactly
   *  the doc_revisions pattern for snapshot content. */
  snapshots: Map<string, SealedBrief>;
}

export class MemoryWorkRepository implements WorkRepository {
  private readonly workspaces = new Map<string, LogPair>();
  private idCounter = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  private logs(scope: WorkspaceScope): LogPair {
    let pair = this.workspaces.get(scope.orgId);
    if (!pair) {
      pair = { events: [], observations: [], dedupe: new Set(), sequences: new Map(), docRevisions: new Map(), views: new Map(), cycles: new Map(), snapshots: new Map() };
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
    const { specs, tasks, initiatives, designs } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    return (
      specs.some((s) => s.key === key) ||
      tasks.some((t) => t.key === key) ||
      initiatives.some((i) => i.key === key) ||
      designs.some((d) => d.key === key)
    );
  }

  async createSpec(scope: WorkspaceScope, input: CreateSpecInput) {
    validateActor(input.actor);
    if (!SLUG_RE.test(input.slug)) {
      throw new WorkError("invalid", `spec slug ${input.slug} must be lowercase kebab`);
    }
    if (this.exists(scope, input.slug)) {
      throw new WorkError("conflict", `spec ${input.slug} already exists`);
    }
    if (input.initiative && !this.exists(scope, input.initiative)) {
      throw new WorkError("not_found", `unknown initiative ${input.initiative}`);
    }
    const payload: ItemCreatedPayload = {
      kind: "Spec",
      key: input.slug,
      title: input.title,
      docRef: input.docRef,
      initiative: input.initiative,
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
    if (input.milestone) {
      this.mustBeLadderMilestone(scope, input.specKey, input.milestone);
    }
    const pair = this.logs(scope);
    const key = `${input.prefix}-${this.nextSeq(pair, input.prefix)}`;
    const payload: ItemCreatedPayload = {
      kind: "Task",
      key,
      title: input.title,
      specKey: input.specKey,
      milestone: input.milestone,
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
      payload: {
        title: input.title,
        description: input.description,
        labels: input.labels,
        docRef: input.docRef,
        initiative: input.initiative,
        targetDate: input.targetDate,
        owner: input.owner,
        successCriteria: input.successCriteria,
      },
    });
    return { event, key: input.key };
  }

  // ── v4 hierarchy mutators (WH1) ────────────────────────────────────────────

  private ladderOf(scope: WorkspaceScope, epicKey: string): Milestone[] {
    return foldMilestones(epicKey, this.logs(scope).events);
  }

  private mustBeEpic(scope: WorkspaceScope, key: string): void {
    const { specs } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    if (!specs.some((s) => s.key === key)) {
      throw new WorkError("not_found", `unknown epic ${key}`);
    }
  }

  private mustBeReviewable(scope: WorkspaceScope, key: string): "epic" | "design" {
    const { specs, designs } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    if (specs.some((s) => s.key === key)) return "epic";
    if (designs.some((d) => d.key === key)) return "design";
    throw new WorkError("not_found", `unknown epic or design ${key}`);
  }

  private mustBeLadderMilestone(scope: WorkspaceScope, epicKey: string | undefined, milestone: string): void {
    if (!epicKey) {
      throw new WorkError("invalid", "a milestone lives inside exactly one epic — the task needs a spec (design §1.2)");
    }
    if (!this.ladderOf(scope, epicKey).some((m) => m.key === milestone)) {
      throw new WorkError("not_found", `milestone ${milestone} is not in ${epicKey}'s ladder`);
    }
  }

  async editMilestone(scope: WorkspaceScope, input: EditMilestoneInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    this.mustBeEpic(scope, input.epicKey);
    if (!isMilestoneKey(input.key)) {
      throw new WorkError("invalid", `milestone key ${input.key} must match the ladder convention (WH2, M1)`);
    }
    const ladder = this.ladderOf(scope, input.epicKey);
    const existing = ladder.find((m) => m.key === input.key);
    switch (input.op) {
      case "create": {
        if (existing) throw new WorkError("conflict", `milestone ${input.key} already exists — keys are immutable`);
        if (!input.title?.trim()) throw new WorkError("invalid", "a milestone needs a title");
        break;
      }
      case "edit":
      case "reorder": {
        if (!existing) throw new WorkError("not_found", `milestone ${input.key} is not in ${input.epicKey}'s ladder`);
        break;
      }
      case "remove": {
        if (!existing) throw new WorkError("not_found", `milestone ${input.key} is not in ${input.epicKey}'s ladder`);
        const { tasks } = buildEnvelopes(scope.orgId, this.logs(scope).events);
        const canceled = new Set(
          this.logs(scope)
            .events.filter((e) => e.kind === "canceled")
            .map((e) => e.subject),
        );
        const open = tasks.filter((t) => t.spec === input.epicKey && t.milestone === input.key && !canceled.has(t.key));
        if (open.length > 0) {
          throw new WorkError(
            "conflict",
            `milestone ${input.key} has ${open.length} open task(s) — move or cancel them first`,
          );
        }
        break;
      }
      default:
        throw new WorkError("invalid", `unknown milestone op ${String(input.op)}`);
    }
    const event = this.append(scope, {
      subject: input.epicKey,
      kind: "milestone_edited",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: {
        op: input.op,
        key: input.key,
        title: input.title,
        goal: input.goal,
        doneWhen: input.doneWhen,
        targetDate: input.targetDate,
        ordinal: input.ordinal,
      },
    });
    return { event, key: input.epicKey };
  }

  async setMilestone(scope: WorkspaceScope, input: SetMilestoneInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    const { tasks } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    const task = tasks.find((t) => t.key === input.key);
    if (!task) throw new WorkError("not_found", `unknown task ${input.key}`);
    if (input.milestone !== null) {
      this.mustBeLadderMilestone(scope, task.spec, input.milestone);
    }
    const event = this.append(scope, {
      subject: input.key,
      kind: "milestone_set",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { milestone: input.milestone },
    });
    return { event, key: input.key };
  }

  async listMilestones(scope: WorkspaceScope, epicKey: string): Promise<Milestone[]> {
    this.mustBeEpic(scope, epicKey);
    return this.ladderOf(scope, epicKey);
  }

  async requestReview(scope: WorkspaceScope, input: RequestReviewInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    this.mustBeReviewable(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind: "review_requested",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { revision: input.revision, reviewers: input.reviewers, note: input.note },
    });
    return { event, key: input.key };
  }

  async submitVerdict(scope: WorkspaceScope, input: SubmitVerdictInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    if (!REVIEW_VERDICTS.includes(input.verdict)) {
      throw new WorkError("invalid", `verdict must be one of ${REVIEW_VERDICTS.join("|")}`);
    }
    this.mustBeReviewable(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind: "review_submitted",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { revision: input.revision, verdict: input.verdict, note: input.note },
    });
    return { event, key: input.key };
  }

  async approve(scope: WorkspaceScope, input: ApproveInput): Promise<CommitOutcome & { snapshot: string }> {
    validateActor(input.actor);
    const { specs } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    const epic = specs.find((s) => s.key === input.key);
    if (!epic) throw new WorkError("not_found", `unknown epic ${input.key}`);
    const ladder = this.ladderOf(scope, input.key);
    if (ladder.length === 0) {
      throw new WorkError("invalid", `epic ${input.key} has no milestones — approval covers the doc AND the ladder (V4-2)`);
    }
    const current = epic.docRef ?? "";
    const revision = input.revision ?? current;
    if (revision !== current) {
      throw new WorkError(
        "conflict",
        `approval of stale revision ${revision || "(none)"} — the epic's document is now ${current || "(none)"}; re-read and re-approve`,
      );
    }
    const min = input.minApprovals ?? 1;
    if (min > 1) {
      const approvers = new Set<string>([input.actor.id]);
      for (const e of this.logs(scope).events) {
        if (e.subject !== input.key || e.kind !== "review_submitted") continue;
        const p = (e.payload ?? {}) as { verdict?: string; revision?: string };
        if (p.verdict === "approve" && e.actor.type === "user" && (p.revision ?? current) === current) {
          approvers.add(e.actor.id);
        }
      }
      if (approvers.size < min) {
        throw new WorkError(
          "invalid",
          `approval needs ${min} distinct human approvals at this revision; have ${approvers.size}`,
        );
      }
    }
    const at = input.at ?? this.now();
    const pair = this.logs(scope);
    const { tasks } = buildEnvelopes(scope.orgId, pair.events);
    const sealed = await sealEpicSnapshot({
      spec: epic,
      milestones: ladder,
      tasks: tasks.filter((t) => t.spec === input.key),
      approval: { revision: revision || undefined, by: input.actor, at },
      catalog: input.catalog,
      coordSeq: (pair.sequences.get("#events") ?? 0) + 1, // incl. the approved event below
      obsSeq: pair.sequences.get("#observations") ?? 0,
    });
    pair.snapshots.set(sealed.id, { id: sealed.id, subject: input.key, canonical: sealed.canonical, createdAt: at });
    const event = this.append(scope, {
      subject: input.key,
      kind: "approved",
      actor: input.actor,
      at,
      payload: { revision: revision || undefined, snapshot: sealed.id },
    });
    return { event, key: input.key, snapshot: sealed.id };
  }

  async getEpicBrief(scope: WorkspaceScope, epicKey: string, id?: string): Promise<SealedBrief> {
    const pair = this.logs(scope);
    if (id) {
      const brief = pair.snapshots.get(id);
      if (!brief || brief.subject !== epicKey) {
        throw new WorkError("not_found", `no sealed brief ${id} for ${epicKey}`);
      }
      return brief;
    }
    const all = [...pair.snapshots.values()].filter((b) => b.subject === epicKey);
    const latest = all[all.length - 1];
    if (!latest) {
      throw new WorkError("not_found", `no sealed brief for ${epicKey} — approval seals one (design §3)`);
    }
    return latest;
  }

  async revokeApproval(scope: WorkspaceScope, input: RevokeApprovalInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    this.mustBeEpic(scope, input.key);
    const events = this.logs(scope).events.filter((e) => e.subject === input.key);
    let approved = false;
    for (const e of events) {
      if (e.kind === "approved") approved = true;
      if (e.kind === "approval_revoked") approved = false;
    }
    if (!approved) {
      throw new WorkError("invalid", `epic ${input.key} has no active approval to revoke`);
    }
    const event = this.append(scope, {
      subject: input.key,
      kind: "approval_revoked",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { note: input.note },
    });
    return { event, key: input.key };
  }

  async createDesign(scope: WorkspaceScope, input: CreateDesignInput) {
    validateActor(input.actor);
    const { initiatives } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    if (!initiatives.some((i) => i.key === input.initiativeKey)) {
      throw new WorkError("not_found", `unknown initiative ${input.initiativeKey}`);
    }
    if (!input.title?.trim()) {
      throw new WorkError("invalid", "a design needs a title");
    }
    validateProposal(input.proposal);
    const pair = this.logs(scope);
    const key = `DSG-${this.nextSeq(pair, "DSG")}`;
    const payload: ItemCreatedPayload = {
      kind: "Design",
      key,
      title: input.title.trim(),
      initiative: input.initiativeKey,
      docRef: input.docRef,
      labels: input.labels,
      context: {
        catalog: input.context?.catalog,
        coordSeq: pair.sequences.get("#events") ?? 0,
        obsSeq: pair.sequences.get("#observations") ?? 0,
      },
      proposal: input.proposal,
    };
    const event = this.append(scope, {
      subject: key,
      kind: "item_created",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: payload as unknown as Record<string, unknown>,
    });
    const { designs } = buildEnvelopes(scope.orgId, pair.events);
    const design = designs.find((d) => d.key === key);
    if (!design) throw new WorkError("invalid", "design did not materialize from its own event");
    return { event, key, design };
  }

  async getDesign(scope: WorkspaceScope, key: string): Promise<Design> {
    const { designs } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    const design = designs.find((d) => d.key === key);
    if (!design) throw new WorkError("not_found", `unknown design ${key}`);
    return design;
  }

  async listDesigns(scope: WorkspaceScope, initiativeKey?: string): Promise<Design[]> {
    const { designs } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    return initiativeKey ? designs.filter((d) => d.initiative === initiativeKey) : designs;
  }

  async adoptDesign(scope: WorkspaceScope, input: AdoptDesignInput): Promise<AdoptOutcome> {
    validateActor(input.actor);
    const design = await this.getDesign(scope, input.key);
    const proposal = design.proposal;
    if (!proposal || proposal.epics.length === 0) {
      throw new WorkError("invalid", `design ${input.key} has no proposal to adopt`);
    }
    const chosen = input.epics
      ? proposal.epics.filter((pe) => input.epics!.includes(pe.slug))
      : proposal.epics;
    if (chosen.length === 0) {
      throw new WorkError("invalid", "adoption selected no proposal epics");
    }
    for (const pe of chosen) {
      if (this.exists(scope, pe.slug)) {
        throw new WorkError("conflict", `proposal epic ${pe.slug} collides with an existing item`);
      }
    }
    const at = input.at ?? this.now();
    const actor = { ...input.actor, via: "adoption" };
    // The decision first — human-only, enforced by validateEvent (V4-2) —
    // then the mint batch in the same "transaction" (design §2).
    const event = this.append(scope, {
      subject: input.key,
      kind: "design_adopted",
      actor,
      at,
      payload: { revision: design.docRef, minted: chosen.map((pe) => pe.slug) },
    });
    const minted: string[] = [];
    const taskKeys: string[] = [];
    const prefix = input.taskPrefix ?? "WK";
    for (const pe of chosen) {
      const specPayload: ItemCreatedPayload = {
        kind: "Spec",
        key: pe.slug,
        title: pe.title,
        docRef: pe.docSeed,
        initiative: design.initiative,
      };
      this.append(scope, {
        subject: pe.slug,
        kind: "item_created",
        actor,
        at,
        payload: specPayload as unknown as Record<string, unknown>,
      });
      minted.push(pe.slug);
      for (const [i, m] of (pe.milestones ?? []).entries()) {
        this.append(scope, {
          subject: pe.slug,
          kind: "milestone_edited",
          actor,
          at,
          payload: {
            op: "create",
            key: m.key,
            title: m.title,
            goal: m.goal,
            doneWhen: m.doneWhen,
            targetDate: m.targetDate,
            ordinal: m.ordinal ?? i,
          },
        });
      }
      for (const ts of pe.taskSkeletons ?? []) {
        const pair = this.logs(scope);
        const key = `${prefix}-${this.nextSeq(pair, prefix)}`;
        const taskPayload: ItemCreatedPayload = {
          kind: "Task",
          key,
          title: ts.title,
          specKey: pe.slug,
          milestone: ts.milestone,
          contract: ts.contract,
        };
        this.append(scope, {
          subject: key,
          kind: "item_created",
          actor,
          at,
          payload: taskPayload as unknown as Record<string, unknown>,
        });
        taskKeys.push(key);
      }
    }
    return { event, minted, tasks: taskKeys };
  }

  async regenerateTasks(scope: WorkspaceScope, input: RegenerateTasksInput): Promise<RegenerateOutcome> {
    validateActor(input.actor);
    this.mustBeLadderMilestone(scope, input.epicKey, input.milestone);
    for (const t of input.tasks) {
      if (!t.title?.trim()) throw new WorkError("invalid", "every regenerated task needs a title");
    }
    const pair = this.logs(scope);
    const { tasks } = buildEnvelopes(scope.orgId, pair.events);
    const ws = { tasks, events: pair.events, observations: pair.observations };
    const fr = fold(ws);
    const at = input.at ?? this.now();

    const canceled: string[] = [];
    const kept: string[] = [];
    for (const t of tasks) {
      if (t.spec !== input.epicKey || t.milestone !== input.milestone) continue;
      const rung = fr.lifecycles[t.key]?.rung ?? "draft";
      if (rung === "canceled") continue;
      if (rung === "draft" || rung === "ready") {
        this.append(scope, { subject: t.key, kind: "canceled", actor: input.actor, at, payload: {} });
        canceled.push(t.key);
      } else {
        kept.push(t.key); // observed activity survives re-planning (Q-6)
      }
    }

    const created: string[] = [];
    const prefix = input.prefix ?? "WK";
    for (const t of input.tasks) {
      const key = `${prefix}-${this.nextSeq(pair, prefix)}`;
      const payload: ItemCreatedPayload = {
        kind: "Task",
        key,
        title: t.title.trim(),
        specKey: input.epicKey,
        milestone: input.milestone,
        contract: t.contract,
      };
      this.append(scope, {
        subject: key,
        kind: "item_created",
        actor: input.actor,
        at,
        payload: payload as unknown as Record<string, unknown>,
      });
      if (t.contract && input.actor.type !== "user") {
        // Flag agent-proposed contracts into the triage review lane — the
        // same discipline as contract_propose (applied AND flagged).
        this.append(scope, {
          subject: key,
          kind: "contract_edited",
          actor: input.actor,
          at,
          payload: { contract: t.contract },
        });
      }
      created.push(key);
    }
    return { canceled, kept, created };
  }

  async supersedeDesign(scope: WorkspaceScope, input: SupersedeDesignInput): Promise<CommitOutcome> {
    validateActor(input.actor);
    await this.getDesign(scope, input.key);
    const event = this.append(scope, {
      subject: input.key,
      kind: "superseded",
      actor: input.actor,
      at: input.at ?? this.now(),
      payload: { by: input.by, note: input.note },
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
    await this.guardDispatch(scope, input);
    return this.simpleEvent(scope, input.key, "assigned", input.actor, input.at, {
      subjectId: input.subject,
      ...(input.override ? { override: input.override } : {}),
    });
  }

  /** The dispatch precondition (v4 WH5, design §3): an agent seat (sp_)
   *  cannot be assigned into an epic whose intent is not Approved. A human
   *  may override WITH a note (the event stays attributed); agents and
   *  automation can never override — server-side, not client trust. */
  private async guardDispatch(scope: WorkspaceScope, input: AssignInput): Promise<void> {
    if (!input.subject.startsWith("sp_")) return;
    const { tasks } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    const task = tasks.find((t) => t.key === input.key);
    if (!task?.spec) return; // inbox tasks have no epic to be approved
    const intent = await foldEpicIntent(task.spec, this.logs(scope).events);
    if (intent.state === "approved") return;
    if (input.actor.type === "user" && input.override?.trim()) return;
    throw new WorkError(
      "invalid",
      `dispatch blocked: epic ${task.spec} is ${intent.state.replace("_", " ")} — agents implement approved briefs. ` +
        (input.actor.type === "user"
          ? "Override with a note to dispatch anyway (attributed), or approve the epic first."
          : "A human can approve the epic or override with a note; agents cannot (V4-2)."),
    );
  }

  async unassign(scope: WorkspaceScope, input: AssignInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "unassigned", input.actor, input.at, { subjectId: input.subject });
  }

  async comment(scope: WorkspaceScope, input: CommentInput): Promise<CommitOutcome> {
    return this.simpleEvent(scope, input.key, "comment_added", input.actor, input.at, {
      body: input.body,
      parentEvent: input.parentEvent,
      anchor: input.anchor,
      reviewsEvent: input.reviewsEvent,
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
    // Initiatives are envelope-only — no rung, no intent to fold a cancel
    // onto. Mirror the SQL repo: reject rather than append a no-op event.
    const { initiatives } = buildEnvelopes(scope.orgId, this.logs(scope).events);
    if (initiatives.some((i) => i.key === input.key)) {
      throw new WorkError(
        "invalid",
        "an initiative has no lifecycle to cancel — edit its envelope, or retire its epics",
      );
    }
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
    const { specs, designs } = buildEnvelopes(scope.orgId, pair.events);
    // Designs carry doc chains exactly like epics (v4, V4-6).
    const documented = specs.find((s) => s.key === input.specKey) ?? designs.find((d) => d.key === input.specKey);
    if (!documented) {
      throw new WorkError("not_found", `unknown spec ${input.specKey}`);
    }
    const body = canonicalDocBody(input.body);
    const revision = await docDigest(body);
    if (revision === documented.docRef) {
      return { revision, parent: documented.docRef, created: false, event: null };
    }
    const parent = input.parent ?? documented.docRef;
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
      const { specs, designs } = buildEnvelopes(scope.orgId, pair.events);
      const documented = specs.find((s) => s.key === specKey) ?? designs.find((d) => d.key === specKey);
      if (!documented) throw new WorkError("not_found", `unknown spec ${specKey}`);
      if (!documented.docRef) throw new WorkError("not_found", `spec ${specKey} has no document`);
      target = documented.docRef;
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
