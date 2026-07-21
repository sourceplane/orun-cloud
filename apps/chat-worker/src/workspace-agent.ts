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
import { modelClientFor, workspaceSystemPrompt } from "./model.js";
import {
  createConfigResolver,
  resolveDispatchModel,
  DISPATCH_MODEL_SETTING_KEY,
  type ProviderConnectionLite,
} from "./custody.js";
import { aguiRunDoor, aguiWatchDoor } from "./agui-doors.js";
import { createClientToolBroker, withClientTools, type ClientToolBroker } from "./client-tools.js";
import type { AguiClientTool } from "@saas/contracts/agui";
import { createOwnerToolExecutor } from "./tools.js";
import { withSessionVerbs } from "./session-verbs.js";
import { formatMemoryForSystem, withMemoryTool, type MemoryEntry, type MemoryRpc } from "./memory.js";
import { uuidToHex } from "@saas/db/ids";
import { OrunCloud } from "@saas/sdk";

export class WorkspaceAgent extends Agent<Env> {
  static override options = { hibernate: true, sendIdentityOnConnect: false };

  private thread = new ChatThread(this.ctx.storage as unknown as ChatStorage);
  private loaded = false;
  /** Per-run client-tool brokers (CX2): runId → the broker + the principal
   * who started the run (results are refused from anyone else). In-memory
   * only — a DO eviction mid-run times the pending call out by design. */
  private aguiBrokers = new Map<string, { broker: ClientToolBroker; principal: string }>();

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
  async turn(orgId: string, text: string, principal: string, ownerToken: string, agui?: { runId: string; tools: AguiClientTool[] }): Promise<{ ok: boolean; reason?: string }> {
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
    // The turn holds the raw UUID (the DO key), but every api-edge surface
    // decodes its org segment via uuidFromPublicId — so all public reads must
    // carry the `org_<hex>` public id, not the bare UUID (a UUID decodes to
    // null → 404, which silently sinks settings + connection discovery).
    const orgPublic = `org_${uuidToHex(orgId)}`;

    const resolveModel = async (): Promise<ModelClient | null> => {
      if (!env.CONFIG_WORKER) return null;
      const doFetch = edgeFetch ?? fetch;

      // Best-effort: the explicit dispatch-model choice (Settings › AI
      // providers). A read failure just falls back to sole-or-default.
      let preferredId: string | null = null;
      try {
        const sres = await doFetch(
          `${baseUrl}/v1/organizations/${orgPublic}/config/settings/resolve?key=${encodeURIComponent(DISPATCH_MODEL_SETTING_KEY)}`,
          { headers: { authorization: `Bearer ${ownerToken}` } },
        );
        if (sres.ok) {
          const sbody = (await sres.json()) as { data?: { setting?: { value?: unknown } } };
          const v = sbody.data?.setting?.value;
          if (typeof v === "string" && v) preferredId = v;
        }
      } catch {
        // fall back to sole-or-default
      }

      const resolved = await resolveDispatchModel(
        {
          listConnections: async () => {
            const res = await doFetch(`${baseUrl}/v1/organizations/${orgPublic}/agents/providers`, {
              headers: { authorization: `Bearer ${ownerToken}` },
            });
            if (!res.ok) return [];
            const body = (await res.json()) as { data?: ProviderConnectionLite[] };
            return body.data ?? [];
          },
          resolveKey: createConfigResolver(env.CONFIG_WORKER, "chat-worker"),
        },
        orgId,
        preferredId,
      );
      if (!resolved) return null;
      // The model call goes DIRECT to the provider (global fetch), not via
      // api-edge — anthropic rides the SDK, openai/openrouter the compat client.
      return modelClientFor(resolved.provider, resolved.key, resolved.config);
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
        orgPublicId: orgPublic,
      },
    );

    const chatId = this.thread.info()?.chatId ?? "unknown";
    const toolsWithMemory = memory
      ? withMemoryTool(tools, memory, { author: principal, source: `chat:${chatId}`, now: () => new Date() })
      : tools;

    // Client tools (CX2): advertised-for-this-turn UI verbs pause the tool
    // round on a per-run broker until the SAME viewer posts the result (or
    // the timeout synthesizes one). Registered only for the run's duration.
    let turnTools = toolsWithMemory;
    if (agui && agui.tools.length > 0) {
      const broker = createClientToolBroker(agui.tools);
      this.aguiBrokers.set(agui.runId, { broker, principal });
      turnTools = withClientTools(toolsWithMemory, broker);
    }

    const startedAt = Date.now();
    let result: Awaited<ReturnType<ChatThread["runTurn"]>>;
    try {
      result = await this.thread.runTurn(text, principal, {
        resolveModel,
        tools: turnTools,
        system: workspaceSystemPrompt(orgId) + formatMemoryForSystem(memoryEntries),
      });
    } finally {
      if (agui) this.aguiBrokers.delete(agui.runId);
    }

    // AN7 — the trust plane's visibility half. Per-turn trace (admin plane
    // reads worker logs): never content, only shape. Metering: the chat
    // loop's tokens land as `agents.chat_tokens` through the PUBLIC usage
    // ingest with the owner's credential (BYO key — the meter is visibility
    // and budget substrate, not billing). Fire-and-forget: a lost sample is
    // a reconciliation problem, never a failed turn.
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

  // ── The AG-UI doors (saas-copilot-surface CX1, design §2) ────────────────
  // Plain-HTTP surface behind the worker router's authz: the RUN door (turn =
  // run, teed into SSE) and the WATCH door (passive follower). Both attach a
  // virtual head to the SAME fan-out every WS head rides — no second emission
  // path. The worker has already authorized the viewer and, for run, carries
  // the owner bearer; the DO never stores either.

  override async onRequest(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const info = this.thread.info();
    const chatId = info?.chatId ?? "unknown";

    if (url.pathname === "/agui-run" && request.method === "POST") {
      let body: {
        orgId?: string;
        text?: string;
        principal?: string;
        ownerToken?: string;
        runId?: string;
        tools?: AguiClientTool[];
      };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const { orgId, text, principal, ownerToken, runId, tools } = body;
      if (!orgId || !text || !principal || !ownerToken) return new Response("missing fields", { status: 400 });
      if (!info || info.orgId !== orgId) return new Response("not found", { status: 404 });
      // Client tools need a stable run id to correlate the result post-back.
      const effectiveRunId = runId ?? `${chatId}:${crypto.randomUUID().slice(0, 8)}`;
      const agui = tools && tools.length > 0 ? { runId: effectiveRunId, tools } : undefined;
      return aguiRunDoor(this.thread, chatId, effectiveRunId, () => this.turn(orgId, text, principal, ownerToken, agui));
    }

    // CX2 — the client-tool result post-back: viewer-authorized upstream,
    // principal-matched to the run here, id-matched + single-use in the
    // broker. 404 unknown run, 403 wrong subject, 409 no pending call.
    if (url.pathname === "/agui-tool-result" && request.method === "POST") {
      let body: { runId?: string; toolCallId?: string; content?: string; isError?: boolean; principal?: string };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return new Response("invalid json", { status: 400 });
      }
      const { runId, toolCallId, content, isError, principal } = body;
      if (!runId || !toolCallId || !principal || typeof content !== "string") {
        return new Response("missing fields", { status: 400 });
      }
      const entry = this.aguiBrokers.get(runId);
      if (!entry) return new Response("no such run", { status: 404 });
      if (entry.principal !== principal) return new Response("forbidden", { status: 403 });
      const resolved = entry.broker.resolve(toolCallId, content, isError);
      if (!resolved) return new Response("no pending call", { status: 409 });
      return Response.json({ resolved: true });
    }

    if (url.pathname === "/agui-watch" && request.method === "GET") {
      const orgId = url.searchParams.get("orgId") ?? "";
      if (!info || info.orgId !== orgId) return new Response("not found", { status: 404 });
      const from = Number(url.searchParams.get("from") ?? "-1");
      return aguiWatchDoor(this.thread, chatId, from, request.signal);
    }

    return new Response("not found", { status: 404 });
  }
}
