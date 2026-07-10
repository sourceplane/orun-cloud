// SessionRelay — the per-session Durable Object (saas-agents-live AL6): a thin
// shell around RelayCore (relay-core.ts). One DO per session ⇒ single-threaded
// serialization of ingest, fan-out, and the input return-queue, the same
// per-run-DO pattern as the coordination RunCoordinator. The DO holds no
// authority over the agent; it is the wire between the sandbox body and the
// heads (saas-agents §4.2).
//
// HTTP surface (all internal, reached from agents-worker route handlers which
// do the authorization):
//   POST /events        body→relay: ingest a batch of attach event frames
//   POST /stream        body→relay: a wire-only delta (fan-out, never stored)
//   GET  /inputs?cursor body→relay: long-poll the head-input return queue
//   POST /inputs/ack    body→relay: ack a head input (resolves the head POST)
//   GET  /attach?from   head→relay: SSE feed (hello → replay → live → live)
//   POST /input         head→relay: one head input frame (awaits the body ack)
//   POST /init          set the session info (hello metadata) once at boot

import { DurableObject } from "cloudflare:workers";
import {
  type AttachFrame,
  decodeFrame,
  encodeSSE,
  isHeadInputFrame,
} from "@saas/contracts/agents-attach";
import { RelayCore, type HeadSink, type RelaySessionInfo, type RelayStorage } from "./relay-core.js";

interface RelayDOEnv {
  ENVIRONMENT: string;
}

const INPUT_POLL_TIMEOUT_MS = 25_000; // below the Workers request budget

export class SessionRelay extends DurableObject<RelayDOEnv> {
  private core: RelayCore;
  private loaded = false;

  constructor(state: DurableObjectState, env: RelayDOEnv) {
    super(state, env);
    // DurableObjectStorage satisfies the RelayStorage subset we use.
    this.core = new RelayCore(state.storage as unknown as RelayStorage, { sessionId: "" });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.core.load();
    this.loaded = true;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      switch (`${request.method} ${path}`) {
        case "POST /init":
          return this.handleInit(request);
        case "POST /events":
          return this.handleEvents(request);
        case "POST /stream":
          return this.handleStream(request);
        case "GET /inputs":
          return this.handlePollInputs(url);
        case "POST /inputs/ack":
          return this.handleAck(request);
        case "GET /attach":
          return this.handleAttach(url);
        case "POST /input":
          return this.handleInput(request);
        default:
          return new Response("not found", { status: 404 });
      }
    } catch (err) {
      return new Response(`relay error: ${(err as Error).message}`, { status: 500 });
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const info = (await request.json()) as RelaySessionInfo;
    // Rebuild the core with the provided info, preserving durable state.
    this.core = new RelayCore(this.ctx.storage as unknown as RelayStorage, info);
    await this.core.load();
    return Response.json({ ok: true });
  }

  private async handleEvents(request: Request): Promise<Response> {
    const batch = (await request.json()) as AttachFrame[];
    const accepted = await this.core.ingestEvents(batch);
    return Response.json({ accepted });
  }

  private async handleStream(request: Request): Promise<Response> {
    const frame = (await request.json()) as AttachFrame;
    if (frame.t === "delta") this.core.fanOutDelta(frame);
    return Response.json({ ok: true });
  }

  private handlePollInputs(url: URL): Response {
    const cursor = Number(url.searchParams.get("cursor") ?? "0");
    const { items, cursor: next } = this.core.pollInputs(cursor);
    return Response.json({ items, cursor: next });
  }

  private async handleAck(request: Request): Promise<Response> {
    const ack = (await request.json()) as AttachFrame;
    this.core.resolveAck(ack);
    return Response.json({ ok: true });
  }

  private async handleInput(request: Request): Promise<Response> {
    const frame = (await request.json()) as AttachFrame;
    if (!isHeadInputFrame(frame)) {
      return new Response("not a head input frame", { status: 400 });
    }
    // The principal is edge-stamped by api-edge into a trusted header; the DO
    // never trusts a self-declared identity in the frame body.
    const principal = request.headers.get("x-actor-principal") || "unknown";
    const ackPromise = this.core.enqueueInput(frame, principal);
    const ack = await withTimeout(ackPromise, INPUT_POLL_TIMEOUT_MS);
    return Response.json(ack);
  }

  private handleAttach(url: URL): Response {
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
    this.core.attach(sink, from);

    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }
}

/** withTimeout resolves a promise or a terminal ack after ms (a head's POST
 * must not hang past the Workers request budget). */
async function withTimeout(p: Promise<AttachFrame>, ms: number): Promise<AttachFrame> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<AttachFrame>((resolve) => {
    timer = setTimeout(() => resolve({ v: 1, t: "ack", ok: false, reason: "terminal" }), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** decodeFrameSafe parses a frame, returning null on malformed input (a
 * defensive helper for future non-JSON paths). */
export function decodeFrameSafe(line: string): AttachFrame | null {
  try {
    return decodeFrame(line);
  } catch {
    return null;
  }
}
