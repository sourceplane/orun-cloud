// Work-plane decision core (orun-work milestone W0, cloud side).
//
// This is the TypeScript mirror of orun's `internal/work` package, which is the
// conformance oracle for the work plane (specs/orun-work/data-model.md). It is
// pure and DB-agnostic: the closed event-kind/status/link vocabularies, the
// entity/contract/event shapes, the mutators (each appends exactly one event
// with a mandatory actor), and the projection reducer that folds the event log
// into the queryable status model.
//
// The SQL repository (./repository.ts) persists these same shapes in Postgres,
// allocating the per-(org,project) `seq` and the `PREFIX-seq` human key in a
// transaction — the Postgres equivalent of the spec's per-project Durable
// Object (the real backend is Supabase/Postgres, not Cloudflare D1; we trust
// code reality over the spec's D1 framing). Keeping the decision logic here,
// pure and unit-tested, is how the SQL layer and the Go oracle cannot drift.

export const API_VERSION = "orun.io/v1";

// ── Closed sets (data-model.md §2, §4.1, §5, §7) ──────────────────────────

export const KINDS = ["Initiative", "Epic", "Task"] as const;
export type Kind = (typeof KINDS)[number];

export const EVENT_KINDS = [
  "item_created",
  "item_edited",
  "status_changed",
  "assigned",
  "unassigned",
  "comment_added",
  "link_added",
  "link_removed",
  "contract_edited",
  "moved",
  "cycle_changed",
  "labeled",
  "unlabeled",
  "sealed",
  "imported",
  "canceled",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "released",
  "canceled",
] as const;
export type Status = (typeof STATUSES)[number];

export const LINK_TYPES = [
  "partOf",
  "hasPart",
  "affects",
  "blockedBy",
  "blocks",
  "implementedBy",
  "delivers",
  "assignedTo",
] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const ACTOR_TYPES = ["user", "agent", "automation"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

const EVENT_KIND_SET: ReadonlySet<string> = new Set(EVENT_KINDS);
const STATUS_SET: ReadonlySet<string> = new Set(STATUSES);
const LINK_TYPE_SET: ReadonlySet<string> = new Set(LINK_TYPES);
const KIND_SET: ReadonlySet<string> = new Set(KINDS);
const ACTOR_TYPE_SET: ReadonlySet<string> = new Set(ACTOR_TYPES);

export function isEventKind(v: string): v is EventKind {
  return EVENT_KIND_SET.has(v);
}
export function isStatus(v: string): v is Status {
  return STATUS_SET.has(v);
}
export function isLinkType(v: string): v is LinkType {
  return LINK_TYPE_SET.has(v);
}
export function isKind(v: string): v is Kind {
  return KIND_SET.has(v);
}

// ── Shapes (data-model.md §2–§4, §7) ──────────────────────────────────────

export interface Actor {
  type: ActorType;
  id: string;
  via?: string | undefined;
}

export interface Contract {
  goal?: string | undefined;
  affects?: string[] | undefined;
  doneWhen?: string[] | undefined;
  gates?: string[] | undefined;
  designRefs?: string[] | undefined;
  deps?: string[] | undefined;
}

export interface Item {
  apiVersion: string;
  kind: Kind;
  id: string;
  key: string;
  project: string;
  title: string;
  doc?: string | undefined;
  parent?: string | undefined;
  cycle?: string | undefined;
  labels?: Record<string, string> | undefined;
  contract?: Contract | undefined;
  createdBy: Actor;
  createdAt: string;
}

export interface Link {
  project: string;
  from: string;
  fromKind: string;
  type: LinkType;
  to: string;
  toKind: string;
  createdBy: Actor;
  createdAt: string;
}

export interface Cause {
  pr?: string | undefined;
  run?: string | undefined;
  deployment?: string | undefined;
}

export interface WorkEvent {
  eventId: string;
  project: string;
  subject: string;
  kind: EventKind;
  actor: Actor;
  at: string;
  payload?: Record<string, unknown> | undefined;
  seq: number;
}

export interface StatusRow {
  project: string;
  key: string;
  status: Status;
  assignees: string[];
  boardOrder: number;
  updatedSeq: number;
}

// ── Errors (the verdicts the one write path returns) ──────────────────────

export type WorkErrorKind =
  | "missing_actor"
  | "unknown_event_kind"
  | "invalid_event"
  | "invalid_argument"
  | "not_found"
  | "conflict"
  | "invalid_link";

export class WorkError extends Error {
  readonly kind: WorkErrorKind;
  constructor(kind: WorkErrorKind, message: string) {
    super(message);
    this.name = "WorkError";
    this.kind = kind;
  }
}

export function validateActor(a: Actor | undefined): void {
  // Every event carries an actor; automation is never attributed to a human
  // (invariant 4, W0 "an event without an actor is rejected").
  if (!a || !a.id) throw new WorkError("missing_actor", "actor id is empty");
  if (!ACTOR_TYPE_SET.has(a.type)) {
    throw new WorkError("missing_actor", `actor type ${a.type} is not user|agent|automation`);
  }
}

export function validateEvent(ev: WorkEvent): void {
  if (!isEventKind(ev.kind)) {
    throw new WorkError("unknown_event_kind", `unknown event kind ${ev.kind}`);
  }
  validateActor(ev.actor);
  if (!ev.subject) throw new WorkError("invalid_event", "subject is empty");
}

// ── Contract derivation (data-model.md §3) ────────────────────────────────

export function contractComplete(c: Contract | undefined): boolean {
  if (!c) return false;
  return Boolean(c.goal) && (c.affects?.length ?? 0) > 0 && (c.doneWhen?.length ?? 0) > 0 && (c.gates?.length ?? 0) > 0;
}

export function agentReady(c: Contract | undefined, resolved?: (componentKey: string) => boolean): boolean {
  if (!contractComplete(c)) return false;
  if (!resolved) return true;
  return (c?.affects ?? []).every(resolved);
}

// ── Keys (data-model.md §1) ───────────────────────────────────────────────

const PREFIX_RE = /^[A-Z]{2,5}$/;
const SLUG_RE = /^[a-z0-9-]+$/;
const COMPONENT_RE = /^[a-z0-9._-]+\/[a-z0-9._-]+\/[a-z0-9._-]+$/;

export function validatePrefix(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) throw new WorkError("invalid_argument", `prefix ${prefix} must be 2-5 uppercase letters`);
}
export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new WorkError("invalid_argument", `slug ${slug} must match [a-z0-9-]+`);
}
export function isComponentKey(key: string): boolean {
  return COMPONENT_RE.test(key);
}
export function formatTaskKey(prefix: string, seq: number): string {
  return `${prefix}-${seq}`;
}
export function taskKeySeq(key: string, prefix: string): number {
  const want = `${prefix}-`;
  if (!key.startsWith(want)) return 0;
  const tail = key.slice(want.length);
  if (!/^[1-9][0-9]*$/.test(tail)) return 0;
  return Number(tail);
}

// ── Options for creating an entity ────────────────────────────────────────

export interface ItemOptions {
  doc?: string | undefined;
  parent?: string | undefined;
  cycle?: string | undefined;
  labels?: Record<string, string> | undefined;
  contract?: Contract | undefined;
}

let idCounter = 0;
/** Test/default id minter. Production callers pass an explicit id factory. */
function defaultId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function createdRef(a: Actor): Actor {
  return { type: a.type, id: a.id };
}

/**
 * WorkProjection is the in-memory system of record + projection: the Postgres
 * tables' behavior, modeled purely. It is the direct port of the Go `State`
 * type and the basis of the invariant-2 conformance test. The SQL repository
 * reproduces this behavior transactionally.
 */
export class WorkProjection {
  readonly project: string;
  readonly prefix: string;
  readonly items = new Map<string, Item>();
  readonly status = new Map<string, StatusRow>();
  links: Link[] = [];

  private seqN = 0;
  private keyN = 0;
  private readonly mintId: (p: string) => string;

  constructor(project: string, prefix: string, mintId: (p: string) => string = defaultId) {
    if (!project) throw new WorkError("invalid_argument", "project is empty");
    validatePrefix(prefix);
    this.project = project;
    this.prefix = prefix;
    this.mintId = mintId;
  }

  nextSeq(): number {
    return this.seqN + 1;
  }

  /** Replay an event log into a fresh projection (invariant 2). */
  static reduce(project: string, prefix: string, events: WorkEvent[], mintId?: (p: string) => string): WorkProjection {
    const s = new WorkProjection(project, prefix, mintId);
    for (const ev of events) {
      validateEvent(ev);
      s.applyEvent(ev);
      if (ev.seq > s.seqN) s.seqN = ev.seq;
    }
    return s;
  }

  private commit(ev: WorkEvent): WorkEvent {
    validateEvent(ev);
    ev.seq = this.seqN + 1;
    this.applyEvent(ev);
    this.seqN = ev.seq;
    return ev;
  }

  private newEvent(kind: EventKind, subject: string, by: Actor, at: string, payload?: Record<string, unknown>): WorkEvent {
    return {
      eventId: this.mintId("wev_"),
      project: this.project,
      subject,
      kind,
      actor: by,
      at,
      payload,
      seq: 0,
    };
  }

  // ── Mutators (each appends exactly one event) ──────────────────────────

  createTask(title: string, opts: ItemOptions, by: Actor, at: string): WorkEvent {
    const key = formatTaskKey(this.prefix, this.keyN + 1);
    return this.createItem("Task", key, title, opts, by, at);
  }

  createEpic(slug: string, title: string, opts: ItemOptions, by: Actor, at: string): WorkEvent {
    validateSlug(slug);
    return this.createItem("Epic", slug, title, opts, by, at);
  }

  createInitiative(slug: string, title: string, opts: ItemOptions, by: Actor, at: string): WorkEvent {
    validateSlug(slug);
    return this.createItem("Initiative", slug, title, opts, by, at);
  }

  private createItem(kind: Kind, key: string, title: string, opts: ItemOptions, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!title) throw new WorkError("invalid_argument", "title is required");
    if (this.items.has(key)) throw new WorkError("conflict", `${key} already exists in ${this.project}`);
    if (opts.contract && kind !== "Task") throw new WorkError("invalid_argument", "only Tasks carry a contract");
    const item: Item = {
      apiVersion: API_VERSION,
      kind,
      id: this.mintId(idPrefixFor(kind)),
      key,
      project: this.project,
      title,
      doc: opts.doc,
      parent: opts.parent,
      cycle: opts.cycle,
      labels: opts.labels,
      contract: opts.contract,
      createdBy: createdRef(by),
      createdAt: at,
    };
    return this.commit(this.newEvent("item_created", key, by, at, { item }));
  }

  editItem(key: string, title: string | undefined, doc: string | undefined, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (title === undefined && doc === undefined) throw new WorkError("invalid_argument", "nothing to edit");
    this.requireItem(key);
    return this.commit(this.newEvent("item_edited", key, by, at, { title, doc }));
  }

  setStatus(key: string, to: Status, cause: Cause | undefined, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!isStatus(to)) throw new WorkError("invalid_argument", `status ${to} is not in the closed set`);
    const row = this.requireStatus(key);
    return this.commit(this.newEvent("status_changed", key, by, at, { from: row.status, to, cause }));
  }

  assign(key: string, principal: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!principal) throw new WorkError("invalid_argument", "principal is required");
    this.requireStatus(key);
    return this.commit(this.newEvent("assigned", key, by, at, { principal }));
  }

  unassign(key: string, principal: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!principal) throw new WorkError("invalid_argument", "principal is required");
    this.requireStatus(key);
    return this.commit(this.newEvent("unassigned", key, by, at, { principal }));
  }

  addComment(key: string, body: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!body) throw new WorkError("invalid_argument", "comment body is required");
    this.requireItem(key);
    return this.commit(this.newEvent("comment_added", key, by, at, { commentId: this.mintId("cmt_"), body }));
  }

  editContract(key: string, contract: Contract | undefined, by: Actor, at: string): WorkEvent {
    validateActor(by);
    const it = this.requireItem(key);
    if (it.kind !== "Task") throw new WorkError("invalid_argument", "only Tasks carry a contract");
    return this.commit(this.newEvent("contract_edited", key, by, at, { contract }));
  }

  addLink(link: Omit<Link, "project" | "createdBy" | "createdAt">, by: Actor, at: string): WorkEvent {
    validateActor(by);
    const full: Link = { ...link, project: this.project, createdBy: createdRef(by), createdAt: at };
    validateLink(full);
    return this.commit(this.newEvent("link_added", full.from, by, at, { link: full }));
  }

  removeLink(link: Pick<Link, "from" | "type" | "to"> & Partial<Link>, by: Actor, at: string): WorkEvent {
    validateActor(by);
    const full: Link = {
      from: link.from,
      fromKind: link.fromKind ?? "",
      type: link.type,
      to: link.to,
      toKind: link.toKind ?? "",
      project: this.project,
      createdBy: createdRef(by),
      createdAt: at,
    };
    validateLink(full);
    return this.commit(this.newEvent("link_removed", full.from, by, at, { link: full }));
  }

  move(key: string, parent: string | undefined, boardOrder: number | undefined, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (parent === undefined && boardOrder === undefined) throw new WorkError("invalid_argument", "nothing to move");
    this.requireItem(key);
    return this.commit(this.newEvent("moved", key, by, at, { parent, boardOrder }));
  }

  setCycle(key: string, cycle: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    const it = this.requireItem(key);
    return this.commit(this.newEvent("cycle_changed", key, by, at, { from: it.cycle ?? "", to: cycle }));
  }

  label(key: string, labelKey: string, value: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!labelKey) throw new WorkError("invalid_argument", "label key is required");
    this.requireItem(key);
    return this.commit(this.newEvent("labeled", key, by, at, { key: labelKey, value }));
  }

  unlabel(key: string, labelKey: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!labelKey) throw new WorkError("invalid_argument", "label key is required");
    this.requireItem(key);
    return this.commit(this.newEvent("unlabeled", key, by, at, { key: labelKey }));
  }

  cancel(key: string, reason: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    const row = this.requireStatus(key);
    return this.commit(this.newEvent("canceled", key, by, at, { from: row.status, reason }));
  }

  seal(key: string, object: string, ref: string, ledgerSeq: number, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!object) throw new WorkError("invalid_argument", "object id is required");
    this.requireItem(key);
    return this.commit(this.newEvent("sealed", key, by, at, { object, ref, ledgerSeq }));
  }

  import(item: Item, source: string, by: Actor, at: string): WorkEvent {
    validateActor(by);
    if (!item.key || !item.title) throw new WorkError("invalid_argument", "imported item needs a key and title");
    if (!isKind(item.kind)) throw new WorkError("invalid_argument", `imported item kind ${item.kind} is invalid`);
    if (this.items.has(item.key)) throw new WorkError("conflict", `${item.key} already exists in ${this.project}`);
    const filled: Item = {
      ...item,
      apiVersion: item.apiVersion || API_VERSION,
      project: item.project || this.project,
    };
    return this.commit(this.newEvent("imported", filled.key, by, at, { item: filled, source }));
  }

  // ── Fold (the reducer body; shared by commit and reduce) ───────────────

  private applyEvent(ev: WorkEvent): void {
    const p = ev.payload ?? {};
    switch (ev.kind) {
      case "item_created":
      case "imported":
        this.createFromEnvelope(p.item as Item, ev.seq);
        return;
      case "item_edited": {
        const it = this.requireItem(ev.subject);
        if (p.title !== undefined && p.title !== null) it.title = p.title as string;
        if (p.doc !== undefined && p.doc !== null) it.doc = p.doc as string;
        return;
      }
      case "status_changed": {
        const row = this.requireStatus(ev.subject);
        row.status = p.to as Status;
        row.updatedSeq = ev.seq;
        return;
      }
      case "canceled": {
        const row = this.requireStatus(ev.subject);
        row.status = "canceled";
        row.updatedSeq = ev.seq;
        return;
      }
      case "assigned": {
        const row = this.requireStatus(ev.subject);
        row.assignees = addSorted(row.assignees, p.principal as string);
        row.updatedSeq = ev.seq;
        return;
      }
      case "unassigned": {
        const row = this.requireStatus(ev.subject);
        row.assignees = row.assignees.filter((a) => a !== (p.principal as string));
        row.updatedSeq = ev.seq;
        return;
      }
      case "moved": {
        const it = this.requireItem(ev.subject);
        if (p.parent !== undefined && p.parent !== null) it.parent = p.parent as string;
        if (p.boardOrder !== undefined && p.boardOrder !== null) {
          const row = this.status.get(ev.subject);
          if (row) {
            row.boardOrder = p.boardOrder as number;
            row.updatedSeq = ev.seq;
          }
        }
        return;
      }
      case "cycle_changed": {
        const it = this.requireItem(ev.subject);
        it.cycle = p.to as string;
        return;
      }
      case "labeled": {
        const it = this.requireItem(ev.subject);
        it.labels = { ...(it.labels ?? {}), [p.key as string]: (p.value as string) ?? "" };
        return;
      }
      case "unlabeled": {
        const it = this.requireItem(ev.subject);
        if (it.labels) {
          delete it.labels[p.key as string];
          if (Object.keys(it.labels).length === 0) it.labels = undefined;
        }
        return;
      }
      case "contract_edited": {
        const it = this.requireItem(ev.subject);
        it.contract = (p.contract as Contract | undefined) ?? undefined;
        return;
      }
      case "link_added": {
        const link = p.link as Link;
        validateLink(link);
        this.upsertLink(link);
        return;
      }
      case "link_removed":
        this.dropLink(p.link as Link);
        return;
      case "comment_added":
      case "sealed":
        // No projection change (comments live in the log; sealing touches no
        // hot state — CR-1).
        return;
      default:
        throw new WorkError("unknown_event_kind", `unknown event kind ${ev.kind}`);
    }
  }

  private createFromEnvelope(item: Item, seq: number): void {
    if (this.items.has(item.key)) {
      throw new WorkError("conflict", `${item.key} already exists in ${this.project}`);
    }
    this.items.set(item.key, structuredClone(item));
    this.status.set(item.key, {
      project: item.project,
      key: item.key,
      status: "backlog",
      assignees: [],
      boardOrder: seq,
      updatedSeq: seq,
    });
    if (item.kind === "Task") {
      const n = taskKeySeq(item.key, this.prefix);
      if (n > this.keyN) this.keyN = n;
    }
  }

  private requireItem(key: string): Item {
    const it = this.items.get(key);
    if (!it) throw new WorkError("not_found", `${key} in ${this.project}`);
    return it;
  }

  private requireStatus(key: string): StatusRow {
    const row = this.status.get(key);
    if (!row) throw new WorkError("not_found", `${key} in ${this.project}`);
    return row;
  }

  private upsertLink(l: Link): void {
    const id = linkIdentity(l);
    const i = this.links.findIndex((e) => linkIdentity(e) === id);
    if (i >= 0) this.links[i] = l;
    else this.links.push(l);
  }

  private dropLink(l: Link): void {
    const id = linkIdentity(l);
    this.links = this.links.filter((e) => linkIdentity(e) !== id);
  }

  /** A stable, order-independent snapshot for byte-for-byte comparison. */
  projectionSnapshot(): { status: StatusRow[]; items: Item[]; links: Link[] } {
    const status = [...this.status.values()].sort((a, b) => a.key.localeCompare(b.key));
    const items = [...this.items.values()].sort((a, b) => a.key.localeCompare(b.key));
    return { status, items, links: this.links };
  }
}

function idPrefixFor(kind: Kind): string {
  switch (kind) {
    case "Initiative":
      return "ini_";
    case "Epic":
      return "epc_";
    default:
      return "tsk_";
  }
}

function validateLink(l: Link): void {
  if (!isLinkType(l.type)) throw new WorkError("invalid_link", `type ${l.type} is not in the work vocabulary`);
  if (!l.project || !l.from || !l.to) throw new WorkError("invalid_link", "project, from and to are required");
}

function linkIdentity(l: Link): string {
  return `${l.project} ${l.from} ${l.type} ${l.to}`;
}

function addSorted(xs: string[], v: string): string[] {
  if (xs.includes(v)) return xs;
  return [...xs, v].sort();
}
