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
