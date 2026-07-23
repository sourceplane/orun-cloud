// IC6 — shared, backoff-disciplined work event tail. Pure logic with injected
// fakes (stream, clock, locks, channel). Includes the measurement simulation
// for the audit's pathology: legs that end immediately (the deployment not
// holding the SSE body) spun the old fixed-1s loop at ~60 connections/min;
// the backoff policy caps the same minute at ~7.

import {
  HEALTHY_LEG_MS,
  RECONNECT_BASE_MS,
  JITTER_FRACTION,
  nextReconnect,
  runTailLoop,
  startWorkEventTail,
  type ReconnectState,
} from "@web-console-next/lib/work/event-tail";

const noJitter = () => 0.5; // random()=0.5 → jitter multiplier exactly 1

describe("nextReconnect policy", () => {
  it("healthy bounded legs keep the designed base cadence and reset the attempt", () => {
    const out = nextReconnect({ attempt: 5 }, HEALTHY_LEG_MS + 1, false, noJitter);
    expect(out.state.attempt).toBe(0);
    expect(out.delayMs).toBe(RECONNECT_BASE_MS);
  });

  it("instant leg completions back off exponentially to the cap", () => {
    let state: ReconnectState = { attempt: 0 };
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      const out = nextReconnect(state, 5, false, noJitter);
      state = out.state;
      delays.push(out.delayMs);
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  });

  it("failures follow the same backoff as instant completions", () => {
    const out = nextReconnect({ attempt: 2 }, HEALTHY_LEG_MS * 2, true, noJitter);
    expect(out.state.attempt).toBe(3);
    expect(out.delayMs).toBe(8000);
  });

  it("jitter stays within ±25%", () => {
    const low = nextReconnect({ attempt: 0 }, 0, false, () => 0);
    const high = nextReconnect({ attempt: 0 }, 0, false, () => 1);
    expect(low.delayMs).toBe(Math.round(2000 * (1 - JITTER_FRACTION)));
    expect(high.delayMs).toBe(Math.round(2000 * (1 + JITTER_FRACTION)));
  });
});

// ── loop simulation on a fake clock ─────────────────────────

interface SimResult {
  connections: number;
}

/** Old behavior for the BEFORE column: fixed 1s reconnect on leg end. */
function simulateOldLoop(windowMs: number, legMs: number): SimResult {
  let t = 0;
  let connections = 0;
  while (t < windowMs) {
    connections += 1;
    t += legMs; // the leg
    t += 1_000; // fixed floor
  }
  return { connections };
}

async function simulateNewLoop(windowMs: number, legMs: number): Promise<SimResult> {
  let simNow = 0;
  let connections = 0;
  const aborter = new AbortController();
  await runTailLoop({
    io: {
      // Each leg ends immediately with no events (the audit pathology when
      // legMs≈0; a healthy bounded server leg when legMs≈55s).
      stream: async function* () {
        connections += 1;
        simNow += legMs;
        if (simNow >= windowMs) aborter.abort();
      },
      poll: () => Promise.resolve(0),
    },
    getCursor: () => 0,
    advance: () => undefined,
    now: () => simNow,
    random: noJitter,
    sleep: (ms) => {
      simNow += ms;
      if (simNow >= windowMs) aborter.abort();
      return Promise.resolve();
    },
    signal: aborter.signal,
  });
  return { connections };
}

describe("IC6 measurement — reconnect volume in a 60s window", () => {
  it("audit pathology (legs end instantly): ~60 connections/min → ≤8", async () => {
    const before = simulateOldLoop(60_000, 0);
    const after = await simulateNewLoop(60_000, 0);
    // eslint-disable-next-line no-console -- measurement record for the IC6 PR
    console.log(`[IC6 bench] instant-leg pathology, 60s window: BEFORE ${before.connections} connections → AFTER ${after.connections}`);
    expect(before.connections).toBe(60);
    expect(after.connections).toBeLessThanOrEqual(8);
  });

  it("healthy 55s legs: cadence unchanged (~2 connections/2min)", async () => {
    const before = simulateOldLoop(120_000, 55_000);
    const after = await simulateNewLoop(120_000, 55_000);
    // eslint-disable-next-line no-console -- measurement record for the IC6 PR
    console.log(`[IC6 bench] healthy 55s legs, 120s window: BEFORE ${before.connections} connections → AFTER ${after.connections}`);
    expect(after.connections).toBe(before.connections);
  });
});

// ── leadership + fan-out ────────────────────────────────────

type Listener = (ev: MessageEvent) => void;

function fakeChannelHub() {
  const channels: Array<{ listeners: Listener[]; closed: boolean }> = [];
  return {
    make() {
      const entry = { listeners: [] as Listener[], closed: false };
      channels.push(entry);
      const channel = {
        postMessage(data: unknown) {
          // BroadcastChannel semantics: everyone EXCEPT the sender.
          for (const other of channels) {
            if (other === entry || other.closed) continue;
            for (const l of other.listeners) l({ data } as MessageEvent);
          }
        },
        close() {
          entry.closed = true;
        },
        addEventListener(_type: string, listener: Listener) {
          entry.listeners.push(listener);
        },
      };
      return channel as unknown as Pick<BroadcastChannel, "postMessage" | "close" | "addEventListener">;
    },
  };
}

/** Single-holder lock manager: first requester wins and holds until abort. */
function fakeLocks() {
  const queue: Array<() => void> = [];
  let held = false;
  const request = (async (_name: string, opts: { signal?: AbortSignal }, cb: () => Promise<unknown>) => {
    const signal = opts.signal;
    if (held) {
      // Park until released (or aborted) — simplified FIFO.
      await new Promise<void>((resolve, reject) => {
        queue.push(resolve);
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    held = true;
    try {
      return await cb();
    } finally {
      held = false;
      queue.shift()?.();
    }
  }) as unknown as LockManager["request"];
  return { request };
}

describe("startWorkEventTail — one stream per org, followers ride the broadcast", () => {
  it("only the lock holder opens connections; followers advance via the channel", async () => {
    const hub = fakeChannelHub();
    const locks = fakeLocks();
    let connections = 0;
    let leaderSeq = 0;
    let followerSeq = 0;

    const io = (onOpen?: () => void) => ({
      // One leg that emits seq 7 then hangs until aborted.
      stream: async function* (_from: number, signal: AbortSignal) {
        connections += 1;
        onOpen?.();
        yield { seq: 7 };
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      },
      poll: () => Promise.resolve(0),
    });

    const leader = startWorkEventTail({
      orgId: "org_1",
      io: io(),
      getCursor: () => leaderSeq,
      advance: (seq) => {
        leaderSeq = Math.max(leaderSeq, seq);
      },
      locks,
      channel: () => hub.make(),
      random: noJitter,
    });
    // Let the leader acquire and emit.
    await new Promise((r) => setTimeout(r, 20));

    const follower = startWorkEventTail({
      orgId: "org_1",
      io: io(),
      getCursor: () => followerSeq,
      advance: (seq) => {
        followerSeq = Math.max(followerSeq, seq);
      },
      locks,
      channel: () => hub.make(),
      random: noJitter,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Exactly ONE connection across both instances; the leader saw seq 7
    // directly. (The follower joined after the emit — it converges via its
    // own summary read; the assertion here is single-connection.)
    expect(connections).toBe(1);
    expect(leaderSeq).toBe(7);

    // New events reach the follower through the channel, not a second stream.
    // Simulate by having the leader publish another seq: restart leader leg is
    // hung, so publish directly through a hub channel.
    const side = hub.make();
    side.postMessage({ seq: 9 });
    await new Promise((r) => setTimeout(r, 10));
    expect(followerSeq).toBe(9);
    expect(leaderSeq).toBe(9);
    expect(connections).toBe(1);

    follower.stop();
    leader.stop();
  });

  it("degrades to a per-instance tail when locks/channel are unavailable", async () => {
    let connections = 0;
    const tail = startWorkEventTail({
      orgId: "org_1",
      io: {
        stream: async function* (_from: number, signal: AbortSignal) {
          connections += 1;
          yield { seq: 1 };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        },
        poll: () => Promise.resolve(0),
      },
      getCursor: () => 0,
      advance: () => undefined,
      locks: undefined,
      channel: () => undefined,
      random: noJitter,
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(connections).toBe(1);
    tail.stop();
  });
});
