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
import { RelayCore, type RelaySessionInfo, type RelayStorage } from "./relay-core.js";
import { connectHead, handleBodyRequest, handleHeadMessage, rejoinHead } from "./relay-shell.js";

interface RelayEnv {
  ENVIRONMENT: string;
}

export class AttachRelay extends Agent<RelayEnv> {
  // Hibernatable WebSockets are the point of the re-platform: an idle
  // attached head no longer pins the DO. Identity chatter is disabled — the
  // wire speaks attach v1 and nothing else (AN lock 2).
  static override options = { hibernate: true, sendIdentityOnConnect: false };

  private core = new RelayCore(this.ctx.storage as unknown as RelayStorage, { sessionId: "" });
  private loaded = false;

  /**
   * ensureLoaded rehydrates after any wake: reload the durable mirror, then
   * re-register every surviving hibernated socket in the fan-out set BEFORE
   * the wake's own work runs — an ingest that woke the DO must reach heads
   * whose sockets outlived the eviction.
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.core.load();
    this.loaded = true;
    for (const conn of this.getConnections()) {
      rejoinHead(this.core, conn);
    }
  }

  /** WS head attach: hello → replay past `from` → live, with the attach
   * params the (already-authorized) worker handler stamped onto the upgrade
   * URL. Mirrors the SSE attach choreography exactly. */
  override async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    await this.ensureLoaded();
    connectHead(this.core, conn, new URL(ctx.request.url));
  }

  /** WS head inputs: steer/verdict/interrupt/end into the return queue with
   * the connection's edge-stamped principal; the body's ack answers on the
   * same socket. Binary messages are not part of attach v1. */
  override async onMessage(conn: Connection, message: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();
    if (typeof message !== "string") return;
    await handleHeadMessage(this.core, conn, message);
  }

  /** A closed socket leaves the presence set; the session continues. */
  override async onClose(conn: Connection): Promise<void> {
    await this.ensureLoaded();
    this.core.detach(conn.id);
  }

  /** The HTTP surface: body routes + the SSE fallback, byte-identical to the
   * AL6 SessionRelay (the body cannot tell which class answered). */
  override async onRequest(request: Request): Promise<Response> {
    await this.ensureLoaded();
    return handleBodyRequest(this.core, request, async (info: RelaySessionInfo) => {
      this.core = new RelayCore(this.ctx.storage as unknown as RelayStorage, info);
      await this.core.load();
      return this.core;
    });
  }
}
