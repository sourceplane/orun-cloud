// Per-connection mint serialization (saas-integration-hub IH6 custody).
//
// A brokered mint on a rotating-parent provider is a read-modify-write on
// custody: read the parent (e.g. the Supabase refresh token) → provider mint
// (which CONSUMES the parent and returns a rotated one) → re-envelope the new
// parent. Two concurrent mints for the same connection race that window: both
// read P0; the first refresh consumes P0 and stores P1; the second presents
// the already-consumed P0 — the provider's refresh-reuse detection then
// refuses the mint or revokes the token family, killing sibling access tokens
// mid-flight (observed live: three parallel CI jobs each minting from one
// Supabase connection — one minted token came back 401).
//
// The fix is the platform's canonical serializer: a Durable Object per
// connection (`idFromName(connectionUuid)`) — globally unique and
// single-threaded, exactly the RunCoordinator rationale. The DO is a FIFO
// LEASE LOCK, not the executor: mint work stays in the worker (it needs
// Hyperdrive, provider fetch, and custody crypto, all wired there); the DO
// only grants turns.
//
//   - `acquire` long-polls: granted immediately when free, else the request
//     parks in a FIFO waiter queue inside the DO (the in-flight request keeps
//     the instance alive) up to a wait budget. A grant carries a ONE-TIME
//     token.
//   - `release` is token-checked — a stale releaser can never free someone
//     else's turn.
//   - The lease TTL is the crashed-holder backstop: a DO alarm clears an
//     expired holder and grants the next waiter. An overrun only degrades to
//     today's (unserialized) behavior — never worse.
//   - A waiter that exhausts its budget fails TYPED (`mint_lock_timeout`), so
//     the failure names itself all the way up to the run log via the
//     resolve's brokerReason plumbing.
//
// Failure posture: serialization is HARDENING, not an authz gate. A missing
// binding (test harness / dev) or a lock-service transport error runs the
// section unlocked — the status-quo posture — rather than blocking mints.

import type { Env } from "./env.js";

/** Lease TTL: a mint's hold is ~one provider HTTP call; 30s is a generous
 *  ceiling, and an expired lease only re-opens today's race window. */
export const DEFAULT_LEASE_MS = 30_000;
/** Waiter budget: bounded queueing. CI's worst observed contention is a
 *  handful of parallel jobs × a few seconds of provider latency each. */
export const DEFAULT_WAIT_MS = 20_000;

export interface LockGrant {
  token: string;
  expiresAt: number;
}

/**
 * The pure lease-lock state machine (time- and token-injected so the
 * semantics are unit-testable without the Workers runtime). The DO wraps it
 * with waiter plumbing + persistence.
 */
export class MintLockCore {
  private holder: LockGrant | null = null;

  constructor(private readonly genToken: () => string = () => crypto.randomUUID()) {}

  /** Rehydrate the persisted holder after a DO cold start. */
  restore(holder: LockGrant | null): void {
    this.holder = holder;
  }

  current(): LockGrant | null {
    return this.holder;
  }

  /** Grant the lock if free (or expired); null means it is held. */
  acquire(nowMs: number, leaseMs: number): LockGrant | null {
    this.expireIfDue(nowMs);
    if (this.holder) return null;
    this.holder = { token: this.genToken(), expiresAt: nowMs + Math.max(1, leaseMs) };
    return this.holder;
  }

  /** Token-checked release: only the current holder frees the lock. */
  release(token: string): boolean {
    if (!this.holder || this.holder.token !== token) return false;
    this.holder = null;
    return true;
  }

  /** Clear an expired holder (the crashed-holder backstop). */
  expireIfDue(nowMs: number): boolean {
    if (this.holder && this.holder.expiresAt <= nowMs) {
      this.holder = null;
      return true;
    }
    return false;
  }
}

// ── The worker-side runner ───────────────────────────────────

export type MintSectionOutcome<T> = { ok: true; value: T } | { ok: false; reason: "mint_lock_timeout" };

/** Runs `fn` while holding the connection's mint lock. Injectable (tests). */
export type MintLockRunner = <T>(connectionUuid: string, fn: () => Promise<T>) => Promise<MintSectionOutcome<T>>;

/**
 * Production runner over the MINT_LOCKS namespace. No binding (harness/dev)
 * or a lock-service TRANSPORT error → run unlocked (status-quo posture); a
 * genuine wait-budget timeout under contention → typed failure.
 */
export function connectionMintLockRunner(
  ns: Env["MINT_LOCKS"],
  opts: { leaseMs?: number; waitMs?: number } = {},
): MintLockRunner {
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  if (!ns) {
    return async (_connectionUuid, fn) => ({ ok: true, value: await fn() });
  }
  return async (connectionUuid, fn) => {
    const stub = ns.get(ns.idFromName(connectionUuid));
    let token: string | null = null;
    try {
      const res = await stub.fetch("https://mint-lock/acquire", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseMs, waitMs }),
      });
      const body = (await res.json()) as { granted?: boolean; token?: string };
      if (!body.granted || typeof body.token !== "string") {
        return { ok: false, reason: "mint_lock_timeout" };
      }
      token = body.token;
    } catch {
      // Lock service unreachable — hardening degrades open, never blocks mints.
      return { ok: true, value: await fn() };
    }
    try {
      return { ok: true, value: await fn() };
    } finally {
      try {
        await stub.fetch("https://mint-lock/release", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
      } catch {
        // The lease TTL is the backstop.
      }
    }
  };
}
