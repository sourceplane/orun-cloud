"use client";

/**
 * Shared, backoff-disciplined tail of the org work event stream (IC6).
 *
 * The 2026-07-23 audit caught the old per-surface loop reconnecting the SSE
 * leg ~once per second: the server's legs are deliberately bounded (~55s),
 * but when the deployment path doesn't hold the leg open each "leg" ends
 * immediately and a fixed 1s floor turns into a reconnect spin — and every
 * open leg holds a server-side DB executor polling every 2.5s. Two fixes,
 * both client-side and independent of the transport verdict (risks doc D2):
 *
 * 1. **Backoff with jitter** — a leg that ends too quickly (< HEALTHY_LEG_MS)
 *    is treated like a failure for pacing purposes: reconnect delay doubles
 *    up to RECONNECT_MAX_MS (±25% jitter so tabs don't thundering-herd).
 *    A healthy bounded leg resets to the base cadence, so the designed
 *    "reconnect from cursor after ~55s" behavior is unchanged.
 * 2. **One stream per org, not per surface/tab** — leadership is a Web Lock
 *    (`orun.work-tail.{org}`): exactly one holder runs the stream loop and
 *    republishes cursor advances on a BroadcastChannel; every other
 *    tab/surface follows the channel. When the leader dies the lock
 *    releases and a follower takes over from its own cursor. Environments
 *    without Web Locks/BroadcastChannel degrade to a per-instance tail
 *    (today's behavior, plus backoff).
 *
 * Everything effectful is injectable, so the policy and the loop are
 * unit-tested with fake streams/clocks/locks (console tests are pure-logic).
 */

export const HEALTHY_LEG_MS = 20_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;
export const JITTER_FRACTION = 0.25;
/** The old failure path's poll-round pause, kept for the degraded mode. */
export const FAILURE_POLL_PAUSE_MS = 12_000;

export interface ReconnectState {
  /** Consecutive unhealthy legs (failures or instant completions). */
  attempt: number;
}

/**
 * Pure reconnect policy. `legMs` is how long the finished leg lasted;
 * `failed` marks a thrown leg (vs a normally-ended one). Returns the next
 * state and the delay before reconnecting, jittered ±JITTER_FRACTION via
 * `random` (0..1).
 */
export function nextReconnect(
  state: ReconnectState,
  legMs: number,
  failed: boolean,
  random: () => number,
): { state: ReconnectState; delayMs: number } {
  const healthy = !failed && legMs >= HEALTHY_LEG_MS;
  if (healthy) {
    return { state: { attempt: 0 }, delayMs: RECONNECT_BASE_MS };
  }
  const attempt = state.attempt + 1;
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt);
  const jitter = 1 + (random() * 2 - 1) * JITTER_FRACTION;
  return { state: { attempt }, delayMs: Math.round(base * jitter) };
}

export interface WorkTailIo {
  /** Open one stream leg from the cursor; yields event seqs until the leg ends. */
  stream: (fromSeq: number, signal: AbortSignal) => AsyncIterable<{ seq: number }>;
  /** One fallback poll round (the old failure path); returns the latest seq seen. */
  poll: (fromSeq: number) => Promise<number>;
}

export interface WorkTailOptions {
  orgId: string;
  io: WorkTailIo;
  getCursor: () => number;
  /** Called with every advanced seq — owner updates its cursor + schedules refetch. */
  advance: (seq: number) => void;
  /** Injectable seams (default to platform globals / real timers). */
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  locks?: Pick<LockManager, "request"> | undefined;
  channel?: (name: string) => Pick<BroadcastChannel, "postMessage" | "close" | "addEventListener"> | undefined;
}

export interface WorkTailHandle {
  stop(): void;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** The leader's leg loop: stream → classify leg health → poll on failure →
 *  backoff sleep. Runs until aborted. Exported for direct unit-testing. */
export async function runTailLoop(
  opts: Required<Pick<WorkTailOptions, "io" | "getCursor" | "advance" | "now" | "random" | "sleep">> & {
    signal: AbortSignal;
    publish?: (seq: number) => void;
  },
): Promise<void> {
  const { io, getCursor, advance, now, random, sleep, signal, publish } = opts;
  let state: ReconnectState = { attempt: 0 };
  while (!signal.aborted) {
    const legStart = now();
    let failed = false;
    try {
      for await (const e of io.stream(getCursor(), signal)) {
        advance(e.seq);
        publish?.(e.seq);
      }
    } catch {
      if (signal.aborted) return;
      failed = true;
      try {
        const seq = await io.poll(getCursor());
        if (seq > getCursor()) {
          advance(seq);
          publish?.(seq);
        }
      } catch {
        // transient — the next round retries
      }
    }
    if (signal.aborted) return;
    const legMs = now() - legStart;
    const next = nextReconnect(state, legMs, failed, random);
    state = next.state;
    await sleep(next.delayMs, signal);
  }
}

/**
 * Start the org tail: leader streams, followers ride the broadcast. Returns
 * a handle whose `stop()` tears everything down (lock released, channel
 * closed, in-flight leg aborted).
 */
export function startWorkEventTail(options: WorkTailOptions): WorkTailHandle {
  const {
    orgId,
    io,
    getCursor,
    advance,
    now = () => Date.now(),
    random = Math.random,
    sleep = defaultSleep,
  } = options;
  const aborter = new AbortController();
  const signal = aborter.signal;

  const locks =
    options.locks !== undefined
      ? options.locks
      : typeof navigator !== "undefined" && "locks" in navigator
        ? navigator.locks
        : undefined;
  const channelFactory =
    options.channel !== undefined
      ? options.channel
      : typeof BroadcastChannel !== "undefined"
        ? (name: string) => new BroadcastChannel(name)
        : () => undefined;

  const bc = channelFactory(`orun.work-tail.${orgId}`);
  if (bc) {
    bc.addEventListener("message", (ev: MessageEvent) => {
      const seq = (ev as MessageEvent<{ seq?: number }>).data?.seq;
      if (typeof seq === "number" && seq > getCursor()) advance(seq);
    });
  }
  const publish = bc ? (seq: number) => bc.postMessage({ seq }) : undefined;

  const loop = (extra?: { publish?: (seq: number) => void }) =>
    runTailLoop({ io, getCursor, advance, now, random, sleep, signal, ...(extra?.publish ? { publish: extra.publish } : {}) });

  if (locks && bc) {
    // Compete for org leadership; whoever holds the lock runs the stream.
    // The request resolves when our callback finishes (i.e. on stop).
    void locks
      .request(`orun.work-tail.${orgId}`, { signal }, async () => {
        if (signal.aborted) return;
        await loop({ ...(publish ? { publish } : {}) });
      })
      .catch(() => {
        // AbortError on stop, or Locks unavailable at request-time: if we
        // were never leader the channel still feeds us; nothing to do.
      });
  } else {
    // Degraded mode: no cross-tab primitives — own tail, with backoff.
    void loop();
  }

  return {
    stop() {
      aborter.abort();
      try {
        bc?.close();
      } catch {
        /* already closed */
      }
    },
  };
}
