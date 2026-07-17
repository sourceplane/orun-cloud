// relay-epoch — session-epoch routing for the SDK re-platform
// (saas-agents-native AN1, lock 7). One decision, used by every relay-facing
// call site (head attach, head input, body wire, the ingest mirror, the
// budget interrupt): which Durable Object class carries this session's relay.

import type { Env } from "./env.js";

/**
 * chooseRelayNamespace: new sessions land on the SQLite `AttachRelay` class;
 * sessions created before the cutover drain on the old `SessionRelay` class
 * (their event mirror lives in that DO's storage — the relay is a projection,
 * but a mid-session class hop would still cost a replay gap). `RELAY_CUTOVER_AT`
 * is the flag-flip instant; unset with both classes bound means every session
 * routes new (fresh environments).
 */
export function chooseRelayNamespace(env: Env, sessionCreatedAt?: string): DurableObjectNamespace | null {
  const next = env.ATTACH_RELAY ?? null;
  const old = env.SESSION_RELAY ?? null;
  if (!next) return old;
  if (!old) return next;
  const cutover = env.RELAY_CUTOVER_AT;
  if (cutover && sessionCreatedAt && sessionCreatedAt < cutover) return old;
  return next;
}

/** relayStubFor resolves the per-session DO instance, or null when unbound. */
export function relayStubFor(env: Env, sessionId: string, sessionCreatedAt?: string): DurableObjectStub | null {
  const ns = chooseRelayNamespace(env, sessionCreatedAt);
  if (!ns) return null;
  return ns.get(ns.idFromName(sessionId));
}

/** The SDK relay's typed RPC surface (saas-agents-native AN3): the worker
 * calls methods, not URLs — the hand-rolled internal route table was always
 * an RPC layer wearing a trench coat (design §4). Upgrade forwarding (WS,
 * SSE) legitimately stays `fetch`: those move a live Request. */
export interface AttachRelayRpc {
  initSession(info: unknown): Promise<void>;
  ingestEvents(frames: unknown[]): Promise<number>;
  streamDelta(frame: unknown): Promise<void>;
  pollInputs(cursor: number): Promise<{ items: unknown[]; cursor: number }>;
  ackInput(ack: unknown): Promise<void>;
  headInput(frame: unknown, principal: string): Promise<unknown>;
  armLease(orgId: string, leaseExpiresAt: string): Promise<void>;
}

export type RelayPeer =
  | { kind: "rpc"; rpc: AttachRelayRpc; stub: DurableObjectStub }
  | { kind: "http"; stub: DurableObjectStub };

/**
 * relayPeerFor resolves the session's relay AND how to talk to it: typed RPC
 * on the SDK class, the legacy HTTP forward on the draining KV class (deleted
 * with it, lock 7).
 */
export function relayPeerFor(env: Env, sessionId: string, sessionCreatedAt?: string): RelayPeer | null {
  const ns = chooseRelayNamespace(env, sessionCreatedAt);
  if (!ns) return null;
  const stub = ns.get(ns.idFromName(sessionId));
  if (ns === env.ATTACH_RELAY) {
    return { kind: "rpc", rpc: stub as unknown as AttachRelayRpc, stub };
  }
  return { kind: "http", stub };
}
