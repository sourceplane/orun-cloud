// Work-plane sync protocol (orun-work milestone W1, design §7).
//
// This is the transport-agnostic contract between the ordering authority (the
// per-project server — a Cloudflare Durable Object in production) and clients
// (the SaaS console, the future MCP). No Durable-Object or WebSocket types
// appear here: the sync contract stays swappable (cross-cutting rule Q-2 — the
// engine-agnostic seam). It depends only on the pure W0 model, never on the
// pg-bearing repository, so a browser client can import it without a database
// driver.

import type { Actor, Contract, ItemOptions, Status, WorkErrorKind, WorkEvent } from "./model.js";
import { WorkError, WorkProjection } from "./model.js";

// ── Mutation intents (client → server) ────────────────────────────────────
// A mutation is an *intent*, not a pre-built event: the client cannot assign
// the authoritative seq (the server does). The same dispatch table applies the
// intent optimistically on the client and authoritatively on the server, so the
// two cannot diverge.

export type MutationOp =
  | { op: "createTask"; title: string; options?: ItemOptions }
  | { op: "createEpic"; slug: string; title: string; options?: ItemOptions }
  | { op: "createInitiative"; slug: string; title: string; options?: ItemOptions }
  | { op: "setStatus"; key: string; status: Status }
  | { op: "assign"; key: string; principal: string }
  | { op: "unassign"; key: string; principal: string }
  | { op: "addComment"; key: string; body: string }
  | { op: "editContract"; key: string; contract?: Contract };

export interface Mutation {
  /** Client-unique correlation id; echoed back so the client retires its
   *  optimistic copy when the authoritative event arrives. */
  clientMutationId: string;
  actor: Actor;
  at: string;
  intent: MutationOp;
}

// ── Messages ──────────────────────────────────────────────────────────────

export interface SubscribeMessage {
  type: "subscribe";
  /** Resume cursor: the last seq the client already has (0 = from the start). */
  fromSeq: number;
}
export interface MutateMessage {
  type: "mutate";
  mutation: Mutation;
}
export type ClientMessage = SubscribeMessage | MutateMessage;

export interface EventMessage {
  type: "event";
  event: WorkEvent;
  /** Present on the broadcast to the mutation's originator. */
  clientMutationId?: string;
}
export interface VerdictMessage {
  type: "verdict";
  verdict: Verdict;
}
export interface ReplayMessage {
  type: "replay";
  events: WorkEvent[];
}
export type ServerMessage = EventMessage | VerdictMessage | ReplayMessage;

// ── The verdict (accept / reject + reason) ────────────────────────────────
// One structured shape, shared with the future MCP (W5): an agent mutator gets
// the identical accept/reject verdict the UI's optimistic client does.

export type Verdict =
  | { ok: true; clientMutationId: string; seq: number }
  | { ok: false; clientMutationId: string; reason: string; code: WorkErrorKind };

// ── Dispatch (the single apply path) ──────────────────────────────────────

/** Apply a mutation intent to a projection: exactly one mutator call → one
 *  event. Used by both the server (authoritative) and the client (optimistic),
 *  so an intent has identical effect on both sides. Throws a WorkError on a
 *  rejected mutation. */
export function dispatch(p: WorkProjection, m: Mutation): WorkEvent {
  const i = m.intent;
  switch (i.op) {
    case "createTask":
      return p.createTask(i.title, i.options ?? {}, m.actor, m.at);
    case "createEpic":
      return p.createEpic(i.slug, i.title, i.options ?? {}, m.actor, m.at);
    case "createInitiative":
      return p.createInitiative(i.slug, i.title, i.options ?? {}, m.actor, m.at);
    case "setStatus":
      return p.setStatus(i.key, i.status, undefined, m.actor, m.at);
    case "assign":
      return p.assign(i.key, i.principal, m.actor, m.at);
    case "unassign":
      return p.unassign(i.key, i.principal, m.actor, m.at);
    case "addComment":
      return p.addComment(i.key, i.body, m.actor, m.at);
    case "editContract":
      return p.editContract(i.key, i.contract, m.actor, m.at);
    default: {
      // Exhaustiveness guard: a new MutationOp must extend this table.
      const _never: never = i;
      throw new WorkError("invalid_argument", `unknown mutation op: ${JSON.stringify(_never)}`);
    }
  }
}
