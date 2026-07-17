// relay-shell — the transport-agnostic glue between RelayCore and a carriage
// (saas-agents-native AN1). The SDK Durable Object (attach-relay.ts) is a thin
// binding of these functions to real `agents` Connections; the jest suite
// drives the SAME functions with fake connections over the golden fixtures,
// which is how the WS binding stays conformant without a workerd in the loop.
//
// Deliberately vendor-free: no `agents` / `cloudflare:workers` imports, only
// structural types — the module (and everything it pulls in) must load under
// plain Node for the fixture suite. The wire is attach v1 on every transport
// (AN lock 2): one frame per WS text message, byte-identical to the SSE line.

import {
  type AttachFrame,
  ATTACH_ACK_REASONS,
  ATTACH_ERROR_CODES,
  ackFrame,
  decodeFrame,
  encodeFrame,
  encodeSSE,
  errorFrame,
  isHeadInputFrame,
} from "@saas/contracts/agents-attach";
import { RelayCore, type HeadSink, type RelaySessionInfo, type RelayStorage } from "./relay-core.js";

/** The slice of an `agents` Connection the shell needs (structurally typed so
 * tests pass plain objects and the module never imports the SDK). */
export interface ConnectionLike {
  readonly id: string;
  send(msg: string): void;
  close(code?: number, reason?: string): void;
  setState(state: unknown): void;
  readonly state: unknown;
}

/** Per-connection attachment state, persisted by the SDK across hibernation
 * (Connection.setState → serializeAttachment) so a wake can rebuild the
 * head registry without re-authorizing or replaying. */
export interface HeadConnState {
  principal: string;
  surface: string;
}

/** The bounded wait for a body ack on a head input — the same budget the HTTP
 * POST path uses; a WS head must not wait longer than an HTTP head would. */
export const INPUT_ACK_TIMEOUT_MS = 25_000;

function headConnState(conn: ConnectionLike): HeadConnState {
  const s = conn.state as Partial<HeadConnState> | null | undefined;
  return {
    principal: typeof s?.principal === "string" ? s.principal : "unknown",
    surface: typeof s?.surface === "string" ? s.surface : "console",
  };
}

/** wsHeadSink adapts a Connection to the core's HeadSink: one attach-v1 frame
 * per WS text message — the same bytes `encodeSSE` wraps, unwrapped. */
export function wsHeadSink(conn: ConnectionLike, principal: string, surface: string): HeadSink {
  return {
    id: conn.id,
    principal,
    surface,
    send(frame: AttachFrame) {
      try {
        conn.send(encodeFrame(frame));
      } catch {
        // A dead socket is dropped by onClose; never throw into the core.
      }
    },
    close() {
      try {
        conn.close(1000, "bye");
      } catch {
        // Already closed.
      }
    },
  };
}

/**
 * connectHead attaches a new WS head connection: read the attach params the
 * worker handler stamped onto the forwarded upgrade URL (from/surface/
 * principal — the DO trusts the handler exactly as the SSE path does), stash
 * them as connection state for hibernation wakes, then run the standard
 * attach choreography (hello → replay past `from` → live).
 */
export function connectHead(core: RelayCore, conn: ConnectionLike, url: URL): void {
  const from = Number(url.searchParams.get("from") ?? "-1");
  const surface = url.searchParams.get("surface") || "console";
  const principal = url.searchParams.get("principal") || "unknown";
  conn.setState({ principal, surface } satisfies HeadConnState);
  core.attach(wsHeadSink(conn, principal, surface), Number.isFinite(from) ? from : -1);
}

/**
 * rejoinHead re-registers a connection that survived a DO eviction (the
 * hibernation seam): the socket is still open client-side, so no hello, no
 * replay — just membership in the fan-out set, from the state the connect
 * persisted.
 */
export function rejoinHead(core: RelayCore, conn: ConnectionLike): void {
  // No persisted state ⇒ the connection never completed connectHead (it is
  // mid-onConnect on this very wake); the attach choreography owns it.
  if (conn.state === null || conn.state === undefined) return;
  const { principal, surface } = headConnState(conn);
  core.rejoin(wsHeadSink(conn, principal, surface));
}

/**
 * handleHeadMessage processes one WS message from a head: head input frames
 * (steer/verdict/interrupt/end) enter the return queue with the connection's
 * edge-stamped principal and the body's ack comes back on the same socket;
 * pong/detach are protocol chatter; anything malformed gets an error frame
 * (never a dropped socket — the head decides what to do about it).
 */
export async function handleHeadMessage(core: RelayCore, conn: ConnectionLike, message: string): Promise<void> {
  let frame: AttachFrame;
  try {
    frame = decodeFrame(message);
  } catch {
    conn.send(encodeFrame(errorFrame(ATTACH_ERROR_CODES.badFrame, "malformed frame")));
    return;
  }
  if (frame.t === "detach") {
    core.detach(conn.id);
    conn.close(1000, "detach");
    return;
  }
  if (!isHeadInputFrame(frame)) {
    // pong and future vocabulary: ignore (forward compatibility, P§5).
    return;
  }
  const { principal } = headConnState(conn);
  const ack = await withAckTimeout(core.enqueueInput(frame, principal), frame.ref || "");
  conn.send(encodeFrame(ack));
}

/** withAckTimeout mirrors the HTTP input POST's bounded wait: a queued input
 * nothing drained in time answers `no_consumer` (the session is alive), never
 * `terminal`. */
async function withAckTimeout(p: Promise<AttachFrame>, ref: string, ms = INPUT_ACK_TIMEOUT_MS): Promise<AttachFrame> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AttachFrame>((resolve) => {
    timer = setTimeout(() => resolve(ackFrame(ref, false, ATTACH_ACK_REASONS.noConsumer)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * handleBodyRequest serves the relay's HTTP surface — byte-identical to the
 * AL6 `SessionRelay` routes, because the body dials the same paths whichever
 * class answers (the migration is invisible on the wire):
 *
 *   POST /init          set session info (hello metadata) once at boot
 *   POST /events        body→relay: ingest a batch of attach event frames
 *   POST /stream        body→relay: a wire-only delta (fan-out, never stored)
 *   GET  /inputs?cursor body→relay: long-poll the head-input return queue
 *   POST /inputs/ack    body→relay: ack a head input
 *   POST /input         head→relay: one input frame (awaits the body ack)
 *   GET  /attach?from   head→relay: the SSE fallback feed (AN lock 2: WS is
 *                       preferred, SSE remains a first-class binding)
 *
 * `reinit` lets the shell rebuild its core around fresh session info (the
 * /init contract the DO shell implements by swapping cores).
 */
export async function handleBodyRequest(
  core: RelayCore,
  request: Request,
  reinit: (info: RelaySessionInfo) => Promise<RelayCore>,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    switch (`${request.method} ${url.pathname}`) {
      case "POST /init": {
        const info = (await request.json()) as RelaySessionInfo;
        await reinit(info);
        return Response.json({ ok: true });
      }
      case "POST /events": {
        const batch = (await request.json()) as AttachFrame[];
        const accepted = await core.ingestEvents(batch);
        return Response.json({ accepted });
      }
      case "POST /stream": {
        const frame = (await request.json()) as AttachFrame;
        if (frame.t === "delta") core.fanOutDelta(frame);
        return Response.json({ ok: true });
      }
      case "GET /inputs": {
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const { items, cursor: next } = core.pollInputs(cursor);
        return Response.json({ items, cursor: next });
      }
      case "POST /inputs/ack": {
        const ack = (await request.json()) as AttachFrame;
        core.resolveAck(ack);
        return Response.json({ ok: true });
      }
      case "POST /input": {
        const frame = (await request.json()) as AttachFrame;
        if (!isHeadInputFrame(frame)) {
          return new Response("not a head input frame", { status: 400 });
        }
        const principal = request.headers.get("x-actor-principal") || "unknown";
        const ack = await withAckTimeout(core.enqueueInput(frame, principal), frame.ref || "");
        return Response.json(ack);
      }
      case "GET /attach":
        return sseAttach(core, url);
      default:
        return new Response("not found", { status: 404 });
    }
  } catch (err) {
    return new Response(`relay error: ${(err as Error).message}`, { status: 500 });
  }
}

// ── The body wire (AN0's cloud door, landed with AN2) ───────────────────────

const BODY_ACKED_KEY = "bw:acked"; // refs the body has acked (bounded by the input queue)

/**
 * RelayShell binds RelayCore to both peer kinds on one DO: HEAD connections
 * (attach → hello/replay/live, inputs in) and the BODY WIRE (orun AN0's one
 * outbound socket: inputs pushed down at enqueue time, acks + deltas coming
 * back up). Pure and storage-injectable like the core — the jest suite drives
 * it with fake connections; attach-relay.ts binds it to the SDK.
 *
 * Delivery discipline for the wire: an input is pushed to every connected
 * body wire when enqueued, and the UNACKED backlog is re-pushed on a fresh
 * wire connect (a reconnecting body missed pushes while dark; the acked set —
 * persisted across hibernation — is what keeps the re-push from duplicating).
 */
export class RelayShell {
  core: RelayCore;
  private bodyWires = new Map<string, ConnectionLike>();
  private acked = new Set<string>();

  constructor(
    private storage: RelayStorage,
    info: RelaySessionInfo,
  ) {
    this.core = new RelayCore(storage, info);
  }

  async load(): Promise<void> {
    await this.core.load();
    const refs = await this.storage.get<string[]>(BODY_ACKED_KEY);
    this.acked = new Set(refs ?? []);
  }

  async reinit(info: RelaySessionInfo): Promise<void> {
    this.core = new RelayCore(this.storage, info);
    await this.core.load();
  }

  private isBodyWire(conn: ConnectionLike): boolean {
    const s = conn.state as { role?: string } | null | undefined;
    return s?.role === "body";
  }

  /** connect routes a fresh WS connection by the forwarded path: the body
   * wire (/wire — session-gated by the worker) or a head attach (/attach). */
  connect(conn: ConnectionLike, url: URL): void {
    if (url.pathname.endsWith("/wire")) {
      conn.setState({ role: "body" });
      this.bodyWires.set(conn.id, conn);
      // Re-push the unacked backlog: everything enqueued while no wire was
      // connected (or pushed on a wire that died before acking).
      const { items } = this.core.pollInputs(0);
      for (const f of items) {
        if (f.ref && this.acked.has(f.ref)) continue;
        conn.send(encodeFrame(f));
      }
      return;
    }
    connectHead(this.core, conn, url);
  }

  /** rejoin re-registers a connection surviving a hibernation wake. A body
   * wire needs no re-push: the socket never dropped, and every enqueue since
   * happened on a wake that re-registered it first. */
  rejoin(conn: ConnectionLike): void {
    if (conn.state === null || conn.state === undefined) return;
    if (this.isBodyWire(conn)) {
      this.bodyWires.set(conn.id, conn);
      return;
    }
    rejoinHead(this.core, conn);
  }

  close(conn: ConnectionLike): void {
    if (this.bodyWires.delete(conn.id)) return;
    this.core.detach(conn.id);
  }

  /** message dispatches one WS message by the connection's role. */
  async message(conn: ConnectionLike, msg: string): Promise<void> {
    if (this.isBodyWire(conn)) {
      await this.bodyMessage(conn, msg);
      return;
    }
    await this.headMessage(conn, msg);
  }

  /** The body's upstream traffic on the wire: acks (inline — resolving the
   * head's blocking input), deltas (fan-out, never stored), bye (terminal). */
  private async bodyMessage(conn: ConnectionLike, msg: string): Promise<void> {
    let frame: AttachFrame;
    try {
      frame = decodeFrame(msg);
    } catch {
      conn.send(encodeFrame(errorFrame(ATTACH_ERROR_CODES.badFrame, "malformed frame")));
      return;
    }
    switch (frame.t) {
      case "ack":
        await this.recordAck(frame);
        break;
      case "delta":
        this.core.fanOutDelta(frame);
        break;
      case "bye":
        await this.core.close(frame.reason || ATTACH_ACK_REASONS.terminal);
        break;
      default:
        // pong and future vocabulary: ignore (forward compatibility).
        break;
    }
  }

  /** Head inputs over WS — the AN1 path, now also pushing to the body wire. */
  private async headMessage(conn: ConnectionLike, msg: string): Promise<void> {
    let frame: AttachFrame;
    try {
      frame = decodeFrame(msg);
    } catch {
      conn.send(encodeFrame(errorFrame(ATTACH_ERROR_CODES.badFrame, "malformed frame")));
      return;
    }
    if (frame.t === "detach") {
      this.core.detach(conn.id);
      conn.close(1000, "detach");
      return;
    }
    if (!isHeadInputFrame(frame)) return;
    const s = conn.state as Partial<HeadConnState> | null | undefined;
    const principal = typeof s?.principal === "string" ? s.principal : "unknown";
    const ack = await withAckTimeout(this.enqueue(frame, principal), frame.ref || "");
    conn.send(encodeFrame(ack));
  }

  /** enqueue puts a head input on the return queue AND pushes it down every
   * connected body wire (push latency — AN0's point). The pushed copy carries
   * the same edge-stamped principal the core stamps into the queued copy. */
  private enqueue(frame: AttachFrame, principal: string): Promise<AttachFrame> {
    const ackP = this.core.enqueueInput(frame, principal);
    const stamped: AttachFrame = { ...frame, payload: { ...(frame.payload ?? {}), principal } };
    const line = encodeFrame(stamped);
    for (const wire of this.bodyWires.values()) {
      try {
        wire.send(line);
      } catch {
        // A dead wire is removed by onClose; the long-poll still has the item.
      }
    }
    return ackP;
  }

  private async recordAck(ack: AttachFrame): Promise<void> {
    if (ack.ref) {
      this.acked.add(ack.ref);
      await this.storage.put(BODY_ACKED_KEY, [...this.acked]);
    }
    this.core.resolveAck(ack);
  }

  /** The HTTP surface — the AL6 routes byte-identical (relay-do parity), with
   * the input + ack doors flowing through the same wire-aware paths. */
  async bodyRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (`${request.method} ${url.pathname}`) {
        case "POST /init": {
          const info = (await request.json()) as RelaySessionInfo;
          await this.reinit(info);
          return Response.json({ ok: true });
        }
        case "POST /events": {
          const batch = (await request.json()) as AttachFrame[];
          const accepted = await this.core.ingestEvents(batch);
          return Response.json({ accepted });
        }
        case "POST /stream": {
          const frame = (await request.json()) as AttachFrame;
          if (frame.t === "delta") this.core.fanOutDelta(frame);
          return Response.json({ ok: true });
        }
        case "GET /inputs": {
          const cursor = Number(url.searchParams.get("cursor") ?? "0");
          const { items, cursor: next } = this.core.pollInputs(cursor);
          return Response.json({ items, cursor: next });
        }
        case "POST /inputs/ack": {
          const ack = (await request.json()) as AttachFrame;
          await this.recordAck(ack);
          return Response.json({ ok: true });
        }
        case "POST /input": {
          const frame = (await request.json()) as AttachFrame;
          if (!isHeadInputFrame(frame)) {
            return new Response("not a head input frame", { status: 400 });
          }
          const principal = request.headers.get("x-actor-principal") || "unknown";
          const ack = await withAckTimeout(this.enqueue(frame, principal), frame.ref || "");
          return Response.json(ack);
        }
        case "GET /attach":
          return sseAttach(this.core, url);
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (err) {
      return new Response(`relay error: ${(err as Error).message}`, { status: 500 });
    }
  }

  /** bodyWireCount reports connected wires (tests/inspection). */
  bodyWireCount(): number {
    return this.bodyWires.size;
  }
}

/** sseAttach is the SSE fallback binding — the AL6 head feed, unchanged. */
function sseAttach(core: RelayCore, url: URL): Response {
  const from = Number(url.searchParams.get("from") ?? "-1");
  const surface = url.searchParams.get("surface") || "console";
  const principal = url.searchParams.get("principal") || "unknown";

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const id = crypto.randomUUID();

  const sink: HeadSink = {
    id,
    principal,
    surface,
    send(frame: AttachFrame) {
      void writer.write(encoder.encode(encodeSSE(frame))).catch(() => {});
    },
    close() {
      void writer.close().catch(() => {});
    },
  };
  core.attach(sink, Number.isFinite(from) ? from : -1);

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
