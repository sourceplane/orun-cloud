// The supervision engine (saas-agent-supervision SV3, design §4) — PURE.
//
// Wake, don't poll; budget every wake. The doorbell coalesces implementer
// events into a bounded, typed digest built from SEALED events (never raw log
// text — §9.2); a rate-limited supervisor turn runs on it. Everything here is
// a pure fold over inputs + an injected clock, so the whole loop is
// fixture-tested vendor-free (the model is the only live seam, and it lives in
// ChatThread). This module makes NO I/O and holds NO state beyond the small
// WakeAccumulator the DO owns.

import {
  ALWAYS_WAKE_KINDS,
  DIGEST_ENTRY_CAP,
  isTerminalSessionState,
  type AgentOrigin,
  type AgentSessionEventKind,
  type AgentSessionState,
  type DigestEntry,
  type EscalationCard,
  type SupervisionDigest,
  type SupervisionMode,
  type WakeKind,
} from "@saas/contracts/agents";

/** One relayed implementer event, joined with its session's origin — the input
 * the doorbell routes to a thread. `principal` is the sealed actor that caused
 * the event (the reflexivity key). */
export interface WakeInput {
  sessionId: string;
  origin: AgentOrigin;
  eventKind: AgentSessionEventKind;
  seq: number;
  at: string;
  payload?: Record<string, unknown>;
  /** The actor that caused the event (from the sealed frame), when known. */
  principal?: string;
}

function str(p: Record<string, unknown> | undefined, k: string): string {
  const v = p?.[k];
  return typeof v === "string" ? v : "";
}

/**
 * wakeKindForEvent — classify a relayed event into a wake kind, or null when it
 * is out of the wake set (tool ticks, deltas, sub-mark cost samples). `budget`
 * and `stuck` are computed by the index (not relayed kinds) and injected as
 * synthetic inputs, so they are honored when pre-classified but never derived
 * from a plain event here.
 */
export function wakeKindForEvent(
  eventKind: AgentSessionEventKind,
  payload?: Record<string, unknown>,
): WakeKind | null {
  switch (eventKind) {
    case "state_changed":
      return isTerminalSessionState(str(payload, "state") as AgentSessionState) ? "terminal" : null;
    case "approval_requested":
      return "approval";
    case "child_spawned":
    case "child_completed":
    case "child_failed":
      return "child";
    default:
      return null;
  }
}

/** A short, SAFE headline for a wake entry — structured, never raw log text. */
function headlineFor(w: WakeInput, wake: WakeKind): string {
  switch (wake) {
    case "terminal":
      return `${w.sessionId} ${str(w.payload, "state") || "ended"}`;
    case "approval": {
      const tool = str(w.payload, "tool");
      return tool ? `${w.sessionId} wants to run ${tool}` : `${w.sessionId} needs a verdict`;
    }
    case "child":
      return `${w.sessionId} ${w.eventKind.replace("child_", "child ")}`;
    case "budget":
      return `${w.sessionId} crossed a budget mark`;
    case "stuck":
      return `${w.sessionId} went quiet`;
  }
}

/** Map a wake input to a digest entry, or null when it is not wake-worthy. A
 * pre-classified synthetic input (budget/stuck) passes `wake` through. */
export function toDigestEntry(w: WakeInput & { wake?: WakeKind }): DigestEntry | null {
  const wake = w.wake ?? wakeKindForEvent(w.eventKind, w.payload);
  if (!wake) return null;
  return {
    sessionId: w.sessionId,
    origin: w.origin,
    wake,
    eventKind: w.eventKind,
    seq: w.seq,
    headline: headlineFor(w, wake),
    at: w.at,
  };
}

/**
 * reflexive — a supervisor turn's own steers/watches must not ring the bell
 * (§4.5): an entry whose cause is the dispatcher principal within the window is
 * dropped, UNLESS it is an always-wake kind (terminal/approval always ring, no
 * matter who caused them).
 */
export function isReflexive(w: WakeInput, dispatcherPrincipal: string | undefined): boolean {
  if (!dispatcherPrincipal) return false;
  if (w.principal !== dispatcherPrincipal) return false;
  const wake = wakeKindForEvent(w.eventKind, w.payload);
  if (wake && (ALWAYS_WAKE_KINDS as readonly string[]).includes(wake)) return false;
  return true;
}

/**
 * buildDigest — collapse a window's wake inputs into ONE bounded, typed digest
 * (§4.2). Dedupes by (sessionId, seq); drops reflexive entries; keeps every
 * terminal/approval entry and caps the rest with an overflow count. Deterministic:
 * ordered by seq then sessionId.
 */
export function buildDigest(
  chatId: string,
  inputs: Array<WakeInput & { wake?: WakeKind }>,
  opts: { dispatcherPrincipal?: string; cap?: number } = {},
): SupervisionDigest {
  const cap = opts.cap ?? DIGEST_ENTRY_CAP;
  const seen = new Set<string>();
  const entries: DigestEntry[] = [];
  let coalesced = 0;
  for (const w of inputs) {
    if (isReflexive(w, opts.dispatcherPrincipal)) continue;
    const entry = toDigestEntry(w);
    if (!entry) continue;
    const key = `${entry.sessionId}:${entry.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    coalesced += 1;
  }
  entries.sort((a, b) => a.seq - b.seq || a.sessionId.localeCompare(b.sessionId));

  // Keep always-wake entries; cap the rest (progress is what falls off).
  const always = entries.filter((e) => (ALWAYS_WAKE_KINDS as readonly string[]).includes(e.wake));
  const rest = entries.filter((e) => !(ALWAYS_WAKE_KINDS as readonly string[]).includes(e.wake));
  const keptRest = rest.slice(0, Math.max(0, cap - always.length));
  const kept = [...always, ...keptRest].sort((a, b) => a.seq - b.seq || a.sessionId.localeCompare(b.sessionId));
  const overflow = entries.length - kept.length;

  return { chatId, entries: kept, overflow, coalesced };
}

/** Does this mode run a model turn? `on` yes; `observe` folds cards only (zero
 * model spend); `off` is doorbell-only. */
export function supervisionRunsModel(mode: SupervisionMode): boolean {
  return mode === "on";
}

/** The escalation cards a digest implies (§4.4) — one per approval entry. The
 * supervisor turn posts these; it CANNOT resolve them (no verdict verb). */
export function escalationsFrom(digest: SupervisionDigest): EscalationCard[] {
  return digest.entries
    .filter((e) => e.wake === "approval")
    .map((e) => ({
      kind: "escalation" as const,
      sessionId: e.sessionId,
      origin: e.origin,
      // The tool/justification are re-read from the sealed approval on the
      // cockpit; the digest headline already carries the safe summary.
      tool: e.headline.replace(/^.*wants to run /, ""),
      requestId: "",
      at: e.at,
    }));
}

/**
 * WakeAccumulator — the DO-owned coalescing buffer (§4.2). Not pure (it holds
 * the window's inputs), but trivially testable with an injected clock: `add`
 * stamps the window open; `due(now)` reports when the window has elapsed;
 * `drain(chatId)` returns the one digest and resets. The DO arms an alarm for
 * the window; this holds no timers itself.
 */
export class WakeAccumulator {
  private inputs: Array<WakeInput & { wake?: WakeKind }> = [];
  private openedAt: number | null = null;

  constructor(private readonly windowMs: number) {}

  add(input: WakeInput & { wake?: WakeKind }, nowMs: number): void {
    if (this.openedAt === null) this.openedAt = nowMs;
    this.inputs.push(input);
  }

  /** True once the coalescing window has elapsed since the first ring. */
  due(nowMs: number): boolean {
    return this.openedAt !== null && nowMs - this.openedAt >= this.windowMs;
  }

  pending(): boolean {
    return this.inputs.length > 0;
  }

  /** Milliseconds until the window is due (for arming an alarm), or null. */
  msUntilDue(nowMs: number): number | null {
    if (this.openedAt === null) return null;
    return Math.max(0, this.windowMs - (nowMs - this.openedAt));
  }

  drain(chatId: string, opts: { dispatcherPrincipal?: string } = {}): SupervisionDigest {
    const digest = buildDigest(chatId, this.inputs, opts);
    this.inputs = [];
    this.openedAt = null;
    return digest;
  }
}
