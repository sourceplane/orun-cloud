// relay-epoch — resolves the per-session relay Durable Object and its typed RPC
// surface (saas-agents-native AN1/AN3). The KV-class cutover (lock 7) is
// COMPLETE: every session lives on the SQLite `AttachRelay` SDK class. The old
// `SessionRelay` class and the `RELAY_CUTOVER_AT` gate are decommissioned —
// there is no longer a class to choose between, nor a legacy HTTP forward.

import type { Env } from "./env.js";

/** The SDK relay namespace, or null when unbound (the dormant posture). */
export function relayNamespace(env: Env): DurableObjectNamespace | null {
  return env.ATTACH_RELAY ?? null;
}

/** relayStubFor resolves the per-session DO instance, or null when unbound. */
export function relayStubFor(env: Env, sessionId: string): DurableObjectStub | null {
  const ns = relayNamespace(env);
  return ns ? ns.get(ns.idFromName(sessionId)) : null;
}

/** The SDK relay's typed RPC surface (saas-agents-native AN3): the worker
 * calls methods, not URLs — the hand-rolled internal route table was always an
 * RPC layer wearing a trench coat (design §4). Upgrade forwarding (WS, SSE)
 * legitimately stays `fetch`: those move a live Request. */
export interface AttachRelayRpc {
  initSession(info: unknown): Promise<void>;
  ingestEvents(frames: unknown[]): Promise<number>;
  streamDelta(frame: unknown): Promise<void>;
  pollInputs(cursor: number): Promise<{ items: unknown[]; cursor: number }>;
  ackInput(ack: unknown): Promise<void>;
  headInput(frame: unknown, principal: string): Promise<unknown>;
  /** Takeover (SV5): take/return the wheel on behalf of the resolved principal. */
  control(action: string, principal: string): Promise<unknown>;
  armLease(orgId: string, leaseExpiresAt: string): Promise<void>;
}

export interface RelayPeer {
  rpc: AttachRelayRpc;
  stub: DurableObjectStub;
}

/** relayPeerFor resolves the session's relay as a typed RPC peer, or null when
 * unbound. */
export function relayPeerFor(env: Env, sessionId: string): RelayPeer | null {
  const ns = relayNamespace(env);
  if (!ns) return null;
  const stub = ns.get(ns.idFromName(sessionId));
  return { rpc: stub as unknown as AttachRelayRpc, stub };
}
