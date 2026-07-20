// DispatchIndex — the DO shell for the Dispatch live layer (saas-dispatch
// DX1): transport + lifecycle only (hibernatable WS via the Agents SDK);
// every decision lives in DispatchIndexCore (dispatch-core.ts), which jest
// drives directly — the ChatThread/RelayCore discipline.

import { Agent, type Connection } from "agents";
import type { Env } from "./env.js";
import type { ChatStorage, ConnectionLike } from "./chat-thread.js";
import { DispatchIndexCore, type DispatchShell } from "./dispatch-core.js";

export { DispatchIndexCore, cursorAdvances, parseCursor } from "./dispatch-core.js";
export type { DispatchShell } from "./dispatch-core.js";

/** The DO shell — transport + lifecycle only (hibernatable WS via the SDK);
 * every decision lives in the core above. */
export class DispatchIndex extends Agent<Env> {
  static override options = { hibernate: true, sendIdentityOnConnect: false };

  private core = new DispatchIndexCore(this.ctx.storage as unknown as ChatStorage);
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.core.load();
    this.loaded = true;
    for (const conn of this.getConnections()) {
      this.core.rejoin(conn as unknown as ConnectionLike);
    }
  }

  override async onConnect(conn: Connection): Promise<void> {
    await this.ensureLoaded();
    this.core.connect(conn as unknown as ConnectionLike);
  }

  override async onMessage(conn: Connection, msg: string | ArrayBuffer): Promise<void> {
    await this.ensureLoaded();
    await this.core.handleMessage(conn as unknown as ConnectionLike, String(msg), new Date().toISOString());
  }

  override async onClose(conn: Connection): Promise<void> {
    await this.ensureLoaded();
    this.core.disconnect(conn.id);
  }

  /** Typed RPC: the worker-side doorbell (rung after chat turns; later the
   * ES-lane consumer). */
  async ring(section?: string): Promise<void> {
    await this.ensureLoaded();
    this.core.ring(section, new Date().toISOString());
  }

  /** Typed RPC: the snapshot-first shell for plain-GET reads (the console
   * paints this before any socket or fold exists). */
  async shell(): Promise<DispatchShell> {
    await this.ensureLoaded();
    return this.core.shellState();
  }

  override async onRequest(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
