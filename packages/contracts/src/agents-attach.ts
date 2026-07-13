// Agents attach protocol (v1) — the wire between a session BODY (the orun
// runtime, `orun agent serve`) and its HEADS (the console, a remote
// `orun agent attach as_…`). This is the TypeScript twin of
// orun/internal/agent/attach (Go); the frame shapes and the golden fixtures
// under agents-attach/fixtures/ are the CROSS-REPO CONTRACT (attach-protocol.md
// §7). Both codecs must round-trip the fixtures byte-identically — a drift in
// either is a failing test, not a field report.
//
// Spec: orun-cloud/specs/epics/saas-agents-live/ (AL6–AL9), paired runtime
// orun/specs/orun-agents-live/ (AL0–AL5). No secret values, no raw transcript
// bytes: bulk content is an R2 ref, the sealed session lives in orun's graph.

/** Highest attach-protocol major this server speaks. */
export const ATTACH_PROTOCOL_VERSION = 1 as const;

// ── Frame types ─────────────────────────────────────────────
// Body → head:
export const ATTACH_BODY_FRAMES = [
  "hello",
  "event",
  "live",
  "delta",
  "presence",
  "ack",
  "ping",
  "bye",
  "error",
] as const;
// Head → body:
export const ATTACH_HEAD_FRAMES = [
  "attach",
  "steer",
  "verdict",
  "interrupt",
  "end",
  "detach",
  "pong",
] as const;

export type AttachBodyFrameType = (typeof ATTACH_BODY_FRAMES)[number];
export type AttachHeadFrameType = (typeof ATTACH_HEAD_FRAMES)[number];
export type AttachFrameType = AttachBodyFrameType | AttachHeadFrameType;

/** Ack reasons (machine-readable). */
export const ATTACH_ACK_REASONS = {
  notPending: "not_pending",
  terminal: "terminal",
  lagged: "lagged",
  // The input was queued but no body drained it before the head's POST timed
  // out — the session is ALIVE, nothing consumed it. Distinct from `terminal`
  // (a genuinely sealed session) so the head can tell "agent not listening yet"
  // apart from "session is over".
  noConsumer: "no_consumer",
} as const;

/** Protocol error codes. */
export const ATTACH_ERROR_CODES = {
  version: "version",
  badFrame: "bad_frame",
} as const;

/** One attached head, as advertised in a presence frame. */
export interface AttachHead {
  principal: string;
  surface: string;
  attachedAt?: string;
}

/**
 * A protocol frame — a flat tagged union keyed by `t`. This mirrors the Go
 * `attach.Frame` struct field-for-field (JSON keys identical) so the two
 * codecs interoperate. Unknown frame types MUST be ignored (forward
 * compatibility); unknown fields are preserved on relay, ignored on consume.
 *
 * The `ref` key is shared deliberately: on an `event` frame it is the
 * transcript-chunk ref; on an input/ack frame it is the correlation id.
 */
export interface AttachFrame {
  v: number;
  t: AttachFrameType;

  // hello
  sessionId?: string;
  state?: string;
  briefId?: string;
  agentType?: string;
  task?: string;
  runKind?: string;
  harness?: string;
  model?: string;
  latestSeq?: number;

  // event (the sealed AgentSessionEvent shape, re-serialized)
  seq?: number;
  kind?: string;
  at?: string;
  payload?: Record<string, unknown>;

  // live / attach cursor
  fromSeq?: number;
  from?: number;

  // delta
  turn?: number;
  text?: string;

  // presence
  heads?: AttachHead[];

  // input correlation / event transcript-chunk ref
  ref?: string;

  // ack
  ok?: boolean;
  reason?: string;

  // verdict
  requestId?: string;
  approved?: boolean;

  // attach
  surface?: string;

  // error / bye
  code?: string;
  message?: string;
}

// ── Constructors (mirror the Go helpers, same key order) ────

export function helloFrame(
  info: {
    sessionId: string;
    briefId?: string;
    agentType?: string;
    task?: string;
    runKind?: string;
    harness?: string;
    model?: string;
  },
  state: string,
  latestSeq: number,
): AttachFrame {
  const f: AttachFrame = { v: ATTACH_PROTOCOL_VERSION, t: "hello", sessionId: info.sessionId, state };
  if (info.briefId) f.briefId = info.briefId;
  if (info.agentType) f.agentType = info.agentType;
  if (info.task) f.task = info.task;
  if (info.runKind) f.runKind = info.runKind;
  if (info.harness) f.harness = info.harness;
  if (info.model) f.model = info.model;
  f.latestSeq = latestSeq;
  return f;
}

export function eventFrame(
  seq: number,
  kind: string,
  at: string,
  payload: Record<string, unknown> | undefined,
  ref?: string,
): AttachFrame {
  const f: AttachFrame = { v: ATTACH_PROTOCOL_VERSION, t: "event", seq, kind };
  if (at) f.at = at;
  if (payload) f.payload = payload;
  if (ref) f.ref = ref;
  return f;
}

export function liveFrame(fromSeq: number): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "live", fromSeq };
}

export function deltaFrame(turn: number, text: string): AttachFrame {
  const f: AttachFrame = { v: ATTACH_PROTOCOL_VERSION, t: "delta", text };
  if (turn) f.turn = turn;
  return f;
}

export function presenceFrame(heads: AttachHead[]): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "presence", heads };
}

export function ackFrame(ref: string, ok: boolean, reason: string): AttachFrame {
  const f: AttachFrame = { v: ATTACH_PROTOCOL_VERSION, t: "ack", ref, ok };
  if (reason) f.reason = reason;
  return f;
}

export function pingFrame(at: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "ping", at };
}

export function pongFrame(at: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "pong", at };
}

export function byeFrame(reason: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "bye", reason };
}

export function errorFrame(code: string, message: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "error", code, message };
}

export function attachFrame(from: number, surface: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "attach", from, surface };
}

export function steerFrame(ref: string, text: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "steer", ref, text };
}

export function verdictFrame(ref: string, requestId: string, approved: boolean, reason: string): AttachFrame {
  const f: AttachFrame = { v: ATTACH_PROTOCOL_VERSION, t: "verdict", ref, requestId, approved };
  if (reason) f.reason = reason;
  return f;
}

export function interruptFrame(ref: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "interrupt", ref };
}

export function endFrame(ref: string): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "end", ref };
}

export function detachFrame(): AttachFrame {
  return { v: ATTACH_PROTOCOL_VERSION, t: "detach" };
}

// ── Codec ───────────────────────────────────────────────────
// The Go side emits compact JSON with `omitempty`, one frame per line
// (NDJSON). `encodeFrame` matches that exactly by dropping undefined fields;
// the field ORDER in AttachFrame mirrors the Go struct so serialization is
// byte-identical.

/** Encode one frame as a single compact JSON line (no trailing newline). */
export function encodeFrame(f: AttachFrame): string {
  // JSON.stringify drops undefined values; the interface field order fixes
  // key order to match the Go struct tags.
  return JSON.stringify(f);
}

/** Encode a frame as an NDJSON line (with the trailing newline). */
export function encodeFrameLine(f: AttachFrame): string {
  return encodeFrame(f) + "\n";
}

/** Parse one NDJSON line into a frame. Throws on malformed JSON. */
export function decodeFrame(line: string): AttachFrame {
  const trimmed = line.trim();
  if (!trimmed) throw new Error("attach: empty frame line");
  return JSON.parse(trimmed) as AttachFrame;
}

/** Parse an NDJSON stream into frames, skipping blank lines. */
export function decodeFrames(ndjson: string): AttachFrame[] {
  const out: AttachFrame[] = [];
  for (const line of ndjson.split("\n")) {
    if (!line.trim()) continue;
    out.push(decodeFrame(line));
  }
  return out;
}

/** Render a frame for the SSE head channel (`data: <json>\n\n`). */
export function encodeSSE(f: AttachFrame): string {
  return `data: ${encodeFrame(f)}\n`;
}

/** True when the frame is a head→body input frame the relay forwards. */
export function isHeadInputFrame(f: AttachFrame): boolean {
  return f.t === "steer" || f.t === "verdict" || f.t === "interrupt" || f.t === "end";
}

/** True when the frame carries a sealed session event (mirrored to storage). */
export function isSealedEventFrame(f: AttachFrame): boolean {
  return f.t === "event";
}
