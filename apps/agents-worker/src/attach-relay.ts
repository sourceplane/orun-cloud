// AttachRelay — the per-session attach relay on the Cloudflare Agents SDK
// (saas-agents-native AN1). The successor class to `SessionRelay`
// (relay-do.ts): same RelayCore, same attach-v1 frames, same body routes —
// the SDK is adopted for TRANSPORT AND LIFECYCLE ONLY (design §2.1). WS heads
// attach via onConnect/onMessage with hibernation; the SSE feed and the HTTP
// body binding remain first-class in onRequest. The relay's contract —
// fan-out, never authority (saas-agents §4.2) — is unchanged, and none of the
// SDK's agentic affordances (AIChatAgent, tool loops, model calls) are used
// here: the relay has no voice.
//
// Migration (AN lock 7): this class lands beside `SessionRelay` under its own
// `new_sqlite_classes` migration tag; session-epoch routing in
// handlers/relay.ts sends new sessions here while old sessions drain on the
// old class. The KV-era class and binding are deleted one release later.

import { Agent, type Connection, type ConnectionContext } from "agents";
import type { RelayStorage } from "./relay-core.js";
import { RelayShell } from "./relay-shell.js";

interface RelayEnv {
  ENVIRONMENT: string;
}

export class AttachRelay extends Agent<RelayEnv> {
  // Hibernatable WebSockets are the point of the re-platform: an idle
  // attached head no longer pins the DO. Identity chatter is disabled — the
  // wire speaks attach v1 and nothing else (AN lock 2).
  static override options = { hibernate: true, sendIdentityOnConnect: false };

  private shell = new RelayShell(this.ctx.storage as unknown as RelayStorage, { sessionId: "" });
  private loaded = false;

  /**
   * ensureLoaded rehydrates after any wake: reload the durable mirror, then
   * re-register every surviving hibernated socket (heads into the fan-out
   * set, body wires into the push set) BEFORE the wake's own work runs — an
   * ingest that woke the DO must reach sockets that outlived the eviction.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.shell.load();
    this.loaded = true;
    for (const conn of this.getConnections()) {
      this.shell.rejoin(conn);
    }
  }

  /** WS connect: a head attach (hello → replay → live) or the body wire
   * (unacked-input re-push), routed by the path the worker handler forwarded
   * — both already authorized upstream. */
  override async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    await this.ensureLoaded();
    this.shell.connect(conn, new URL(ctx.request.url));
  }

  /** WS messages: head inputs (→ return queue + body-wire push, acked on the
   * head's socket) or body traffic (acks/deltas/bye). Binary messages are not
   * part of attach v1. */
  override async onMessage(conn: Connection, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();
    if (typeof message !== "string") return;
    await this.shell.message(conn, message);
  }

  /** A closed socket leaves the presence/push set; the session continues. */
  override async onClose(conn: Connection): Promise<void> {
    await this.ensureLoaded();
    this.shell.close(conn);
  }

  /** The HTTP surface: body routes + the SSE fallback, byte-identical to the
   * AL6 SessionRelay (the body cannot tell which class answered). */
  override async onRequest(request: Request): Promise<Response> {
    await this.ensureLoaded();
    return this.shell.bodyRequest(request);
  }
}
