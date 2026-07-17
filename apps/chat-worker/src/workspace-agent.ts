// WorkspaceAgent — the durable conversational brain (saas-agents-native AN4),
// one DO per chat thread, named `chat:<chatId>`, workspace-bound immutably at
// init. Extends the SDK's Agent for transport + lifecycle (hibernatable WS
// heads, schedule() for the AN6 proactive plane); the conversation itself
// lives in ChatThread (chat-thread.ts), which is where jest drives fixtures.
//
// Deviation from the design table's `AIChatAgent` (recorded in
// IMPLEMENTATION-STATUS): the SDK chat class binds the thread to its own
// client protocol + React stack; this platform's head idiom (replay → live
// frames, cursor resume — proven twice now) plus a ModelClient seam gives
// the same product surface (durable thread, resumable streaming) while
// keeping the loop fixture-testable and the console vendor-free.

import { Agent, type Connection, type ConnectionContext } from "agents";
import type { Env } from "./env.js";
import { ChatThread, type ChatMeta, type ChatStorage, type ModelClient } from "./chat-thread.js";
import { anthropicModel, workspaceSystemPrompt } from "./model.js";
import { createConfigResolver, resolveAnthropicKey, type ProviderConnectionLite } from "./custody.js";
import { createOwnerToolExecutor } from "./tools.js";
import { withSessionVerbs } from "./session-verbs.js";
import { uuidToHex } from "@saas/db/ids";

export class WorkspaceAgent extends Agent<Env> {
  static override options = { hibernate: true, sendIdentityOnConnect: false };

  private thread = new ChatThread(this.ctx.storage as unknown as ChatStorage);
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.thread.load();
    this.loaded = true;
    for (const conn of this.getConnections()) {
      this.thread.rejoin(conn);
    }
  }

  // ── Typed RPC (the worker calls methods, AN3 discipline from day one) ─────

  async initChat(meta: ChatMeta): Promise<void> {
    await this.ensureLoaded();
    await this.thread.init(meta);
  }

  async chatInfo(): Promise<ChatMeta | null> {
    await this.ensureLoaded();
    return this.thread.info();
  }

  async history(orgId: string): Promise<unknown[]> {
    await this.ensureLoaded();
    this.thread.assertOrg(orgId);
    return this.thread.history();
  }

  /**
   * turn — one user turn. The owner's bearer rides in from the worker for
   * THIS turn only (tool calls re-enter api-edge with it; custody resolves
   * the model key); nothing credential-shaped is stored.
   */
  async turn(orgId: string, text: string, principal: string, ownerToken: string): Promise<{ ok: boolean; reason?: string }> {
    await this.ensureLoaded();
    this.thread.assertOrg(orgId);
    const env = this.env;
    const baseUrl = env.API_EDGE_URL || "https://api-edge.internal";
    const edgeFetch: typeof fetch | undefined = env.API_EDGE
      ? (((input: RequestInfo | URL, init?: RequestInit) => env.API_EDGE!.fetch(input as never, init as never)) as typeof fetch)
      : undefined;

    const resolveModel = async (): Promise<ModelClient | null> => {
      if (!env.CONFIG_WORKER) return null;
      const key = await resolveAnthropicKey(
        {
          listConnections: async (org) => {
            const res = await (edgeFetch ?? fetch)(`${baseUrl}/v1/organizations/${org}/agents/providers`, {
              headers: { authorization: `Bearer ${ownerToken}` },
            });
            if (!res.ok) return [];
            const body = (await res.json()) as { data?: ProviderConnectionLite[] };
            return body.data ?? [];
          },
          resolveKey: createConfigResolver(env.CONFIG_WORKER, "chat-worker"),
        },
        orgId,
      );
      return key ? anthropicModel(key, edgeFetch ? undefined : undefined) : null;
    };

    // The hands (AN5): session verbs beside the read-only platform tools —
    // spawn/steer/interrupt/watch, all owner-credentialed public re-entry.
    const tools = withSessionVerbs(
      createOwnerToolExecutor({
        baseUrl,
        ownerToken,
        ...(edgeFetch ? { fetchFn: edgeFetch } : {}),
      }),
      {
        baseUrl,
        ownerToken,
        http: { fetch: (edgeFetch ?? fetch) as (input: string, init?: RequestInit) => Promise<Response> },
        orgPublicId: `org_${uuidToHex(orgId)}`,
      },
    );

    return this.thread.runTurn(text, principal, {
      resolveModel,
      tools,
      system: workspaceSystemPrompt(orgId),
    });
  }

  // ── The read plane (WS heads: replay → live) ─────────────────────────────

  override async onConnect(conn: Connection, ctx: ConnectionContext): Promise<void> {
    await this.ensureLoaded();
    const url = new URL(ctx.request.url);
    const from = Number(url.searchParams.get("from") ?? "-1");
    this.thread.connect(conn, Number.isFinite(from) ? from : -1);
  }

  override async onMessage(): Promise<void> {
    // The chat WS is the read plane; turns enter through the credentialed
    // POST. Head messages are ignored (forward compatibility).
  }

  override async onClose(conn: Connection): Promise<void> {
    await this.ensureLoaded();
    this.thread.disconnect(conn.id);
  }

  override async onRequest(): Promise<Response> {
    return new Response("not found", { status: 404 });
  }
}
