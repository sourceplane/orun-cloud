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
import { formatMemoryForSystem, withMemoryTool, type MemoryEntry, type MemoryRpc } from "./memory.js";
import { uuidToHex } from "@saas/db/ids";
import { OrunCloud } from "@saas/sdk";

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
    // Brief assembly (AN6): the workspace memory plane folds into the turn's
    // system context — a remembered fact shapes every later thread.
    const memory: MemoryRpc | null = env.WORKSPACE_MEMORY
      ? (env.WORKSPACE_MEMORY.get(env.WORKSPACE_MEMORY.idFromName(`wsmem:${orgId}`)) as unknown as MemoryRpc)
      : null;
    let memoryEntries: MemoryEntry[] = [];
    if (memory) {
      try {
        memoryEntries = await memory.listEntries();
      } catch {
        // A memory outage degrades the brief, never the turn.
      }
    }
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

    const chatId = this.thread.info()?.chatId ?? "unknown";
    const toolsWithMemory = memory
      ? withMemoryTool(tools, memory, { author: principal, source: `chat:${chatId}`, now: () => new Date() })
      : tools;

    const startedAt = Date.now();
    const result = await this.thread.runTurn(text, principal, {
      resolveModel,
      tools: toolsWithMemory,
      system: workspaceSystemPrompt(orgId) + formatMemoryForSystem(memoryEntries),
    });

    // AN7 — the trust plane's visibility half. Per-turn trace (admin plane
    // reads worker logs): never content, only shape. Metering: the chat
    // loop's tokens land as `agents.chat_tokens` through the PUBLIC usage
    // ingest with the owner's credential (BYO key — the meter is visibility
    // and budget substrate, not billing). Fire-and-forget: a lost sample is
    // a reconciliation problem, never a failed turn.
    const orgPublic = `org_${uuidToHex(orgId)}`;
    console.warn(
      `[chat-turn] chat=${chatId} org=${orgPublic} ok=${result.ok}${result.reason ? ` reason=${result.reason}` : ""} tools=${result.toolCalls ?? 0} tokens=${result.tokens ?? 0} ms=${Date.now() - startedAt}`,
    );
    if (result.ok && (result.tokens ?? 0) > 0) {
      try {
        const sdk = new OrunCloud({
          baseUrl,
          auth: { kind: "bearer", token: ownerToken },
          ...(edgeFetch ? { fetch: edgeFetch } : {}),
        });
        void sdk.metering
          .recordUsage(orgPublic, {
            metric: "agents.chat_tokens",
            quantity: result.tokens ?? 0,
            metadata: { chatId },
            idempotencyKey: `chat_turn_${crypto.randomUUID()}`,
          })
          .catch(() => {});
      } catch {
        // Metering never blocks the voice.
      }
    }
    return result;
  }

  /** destroyThread (AN7 hardening): deletion is complete — the DO's storage
   * IS the thread; after this there is nothing to export. */
  async destroyThread(orgId: string): Promise<void> {
    await this.ensureLoaded();
    this.thread.assertOrg(orgId);
    await this.ctx.storage.deleteAll();
    this.loaded = false;
    this.thread = new ChatThread(this.ctx.storage as unknown as ChatStorage);
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
