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
import type { AttachFrame } from "@saas/contracts/agents-attach";
import { isTerminalSessionState } from "@saas/contracts/agents";
import type { Env } from "./env.js";
import { buildDeps, ready } from "./deps.js";
import type { RelayStorage } from "./relay-core.js";
import type { RelaySessionInfo } from "./relay-core.js";
import { RelayShell } from "./relay-shell.js";
import { RELAY_LEASE_GRACE_MS, RELAY_RETENTION_MS, reportLeaseLapse } from "./relay-lifecycle.js";

const LEASE_ORG_KEY = "lease:org"; // the workspace this session belongs to (for the alarm's DB read)

export class AttachRelay extends Agent<Env> {
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

  // ── Typed RPC (AN3): the worker calls methods, not URLs ──────────────────

  async initSession(info: RelaySessionInfo): Promise<void> {
    await this.ensureLoaded();
    await this.shell.reinit(info);
  }

  async ingestEvents(frames: AttachFrame[]): Promise<number> {
    await this.ensureLoaded();
    const accepted = await this.shell.core.ingestEvents(frames);
    // Seal detection: a terminal state_changed arms retention GC and stands
    // the lease timer down — the session has nothing left to lapse.
    for (const f of frames) {
      const st = typeof f.payload?.state === "string" ? f.payload.state : "";
      if (f.t === "event" && f.kind === "state_changed" && isTerminalSessionState(st as Parameters<typeof isTerminalSessionState>[0])) {
        await this.cancelCallbacks("onLeaseLapse");
        await this.cancelCallbacks("onRetentionDue");
        await this.schedule(new Date(Date.now() + RELAY_RETENTION_MS), "onRetentionDue");
        break;
      }
    }
    return accepted;
  }

  async streamDelta(frame: AttachFrame): Promise<void> {
    await this.ensureLoaded();
    if (frame.t === "delta") this.shell.core.fanOutDelta(frame);
  }

  async pollInputs(cursor: number): Promise<{ items: AttachFrame[]; cursor: number }> {
    await this.ensureLoaded();
    return this.shell.core.pollInputs(cursor);
  }

  async ackInput(ack: AttachFrame): Promise<void> {
    await this.ensureLoaded();
    await this.shell.ack(ack);
  }

  async headInput(frame: AttachFrame, principal: string): Promise<AttachFrame> {
    await this.ensureLoaded();
    return this.shell.headInput(frame, principal);
  }

  // ── Lifecycle in the object (AN3): timers, not authority ─────────────────

  /** armLease (re)arms the lease-lapse timer — called on every heartbeat, so
   * a healthy session's timer never fires. Fires one grace past the lease. */
  async armLease(orgId: string, leaseExpiresAt: string): Promise<void> {
    await this.ensureLoaded();
    await this.ctx.storage.put(LEASE_ORG_KEY, orgId);
    await this.cancelCallbacks("onLeaseLapse");
    const due = new Date(new Date(leaseExpiresAt).getTime() + RELAY_LEASE_GRACE_MS);
    await this.schedule(due, "onLeaseLapse");
  }

  /** onLeaseLapse: heartbeats stopped. Re-read control-plane truth and either
   * re-arm (they resumed via another path) or report-and-reclaim through the
   * same shared path the backstop cron uses. The DO reports; the control
   * plane's transition table still decides. */
  async onLeaseLapse(): Promise<void> {
    await this.ensureLoaded();
    const orgId = await this.ctx.storage.get<string>(LEASE_ORG_KEY);
    const env = this.env;
    if (!orgId || !ready(env)) return;
    const deps = buildDeps(env);
    try {
      const r = await reportLeaseLapse(deps, orgId, this.name, `relay_lease_${this.name}`);
      if (r.outcome === "active") {
        await this.cancelCallbacks("onLeaseLapse");
        await this.schedule(new Date(r.rearmAt), "onLeaseLapse");
      } else if (r.outcome === "reclaimed") {
        console.warn(`[agents-relay-lease] session=${this.name} self-reported lease lapse → reclaimed`);
      }
    } finally {
      await deps.dispose();
    }
  }

  /** onRetentionDue: the sealed session's mirror ages out — the object purges
   * its own KV storage (events, meta, queues). The DB log and the sealed
   * snapshot in orun's graph are the record; this was always a projection. */
  async onRetentionDue(): Promise<void> {
    console.warn(`[agents-relay-retention] session=${this.name} mirror purged after retention window`);
    await this.ctx.storage.deleteAll();
  }

  private async cancelCallbacks(callback: string): Promise<void> {
    for (const s of this.getSchedules()) {
      if (s.callback === callback) await this.cancelSchedule(s.id);
    }
  }
}
