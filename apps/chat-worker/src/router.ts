// chat-worker router (saas-agents-native AN4). Org-scoped chat routes behind
// deny-by-default authz (`organization.agent.chat` via POLICY_WORKER — a
// gate, not a capability). api-edge resolves the actor and stamps x-actor-*;
// the turn route additionally carries the owner's bearer (x-owner-bearer,
// set by the edge for this route only) so tool calls and custody re-enter
// public surfaces AS the owner.

import type { Env } from "./env.js";
import { errorResponse, methodNotAllowed, notFound, successResponse } from "./http.js";
import type { ChatMeta } from "./chat-thread.js";
import type { ChatSummary } from "./chat-index.js";
import type { MemoryRpc } from "./memory.js";
import { fetchAuthorizationContext } from "./membership-client.js";
import { authorizeViaPolicy } from "./policy-client.js";
import type { PolicyResource } from "@saas/contracts/policy";
import { validClientTools, type AguiRunInput } from "@saas/contracts/agui";
import { uuidFromPublicId } from "@saas/db/ids";

const CHATS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats$/;
const MEMORY_RE = /^\/v1\/organizations\/([^/]+)\/agents\/memory$/;
const MEMORY_ENTRY_RE = /^\/v1\/organizations\/([^/]+)\/agents\/memory\/([^/]+)$/;
const CHAT_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats\/([^/]+)$/;
const CHAT_TURN_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats\/([^/]+)\/turn$/;
// The AG-UI doors (saas-copilot-surface CX1): run (turn = run over SSE, the
// owner bearer rides exactly as the turn route's) and watch (passive SSE
// follower — the same frames every WS head receives, through the bridge).
const CHAT_AGUI_RUN_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats\/([^/]+)\/agui\/run$/;
const CHAT_AGUI_WATCH_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats\/([^/]+)\/agui\/watch$/;
// The Dispatch live layer (saas-dispatch DX1): WS attach (upgrade) or the
// snapshot-first shell (plain GET). The DO holds no authorized content —
// the same chat grant gates the wire, and heads fold with their own bearer.
const DISPATCH_INDEX_RE = /^\/v1\/organizations\/([^/]+)\/dispatch\/index$/;

interface Actor {
  subjectId: string;
  subjectType: string;
}

/** The typed RPC surfaces of the two DO classes (worker-side view). */
export interface WorkspaceAgentRpc {
  initChat(meta: ChatMeta): Promise<void>;
  chatInfo(): Promise<ChatMeta | null>;
  history(orgId: string): Promise<unknown[]>;
  turn(orgId: string, text: string, principal: string, ownerToken: string): Promise<{ ok: boolean; reason?: string; tokens?: number; toolCalls?: number }>;
  destroyThread(orgId: string): Promise<void>;
}
export interface ChatIndexRpc {
  register(chat: ChatSummary): Promise<void>;
  touch(chatId: string, lastAt: string): Promise<void>;
  removeChat(chatId: string): Promise<void>;
  listChats(): Promise<ChatSummary[]>;
}

export interface ChatDeps {
  authorize(action: string, orgId: string, actor: Actor, requestId: string): Promise<boolean>;
  now(): Date;
  newChatId(): string;
}

export function buildDeps(env: Env): ChatDeps {
  return {
    async authorize(action, orgId, actor, requestId) {
      // The authz gate, done the way every other worker does it (this was the
      // bug that shipped: the hand-rolled call sent {orgId,action,subjectId,
      // subjectType} and read data.allowed, but the policy-worker REQUIRES a
      // {subject, action, resource, context:{memberships}} body and answers
      // data.allow — and the caller must fetch the memberships. The mismatch
      // 400'd every request, so deny-by-default denied every chat + dispatch
      // route with "Not authorized"). Fetch the actor's role assignments from
      // membership-worker, then evaluate through policy-worker with the real
      // contract.
      if (!env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) return false;
      const ctx = await fetchAuthorizationContext(
        env.MEMBERSHIP_WORKER,
        actor.subjectId,
        actor.subjectType,
        orgId,
        requestId,
      );
      if (!ctx.ok) return false;
      const resource: PolicyResource = { kind: "organization", orgId };
      const res = await authorizeViaPolicy(
        env.POLICY_WORKER,
        actor.subjectId,
        actor.subjectType,
        action,
        resource,
        ctx.memberships,
        requestId,
      );
      return res.allow;
    },
    now: () => new Date(),
    newChatId: () => `ch_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
  };
}

function resolveActor(request: Request): Actor | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

function requestId(request: Request): string {
  return request.headers.get("x-request-id") || `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function agentStub(env: Env, chatId: string): WorkspaceAgentRpc | null {
  if (!env.WORKSPACE_AGENT) return null;
  return env.WORKSPACE_AGENT.get(env.WORKSPACE_AGENT.idFromName(`chat:${chatId}`)) as unknown as WorkspaceAgentRpc;
}

function memoryStub(env: Env, orgId: string): MemoryRpc | null {
  if (!env.WORKSPACE_MEMORY) return null;
  return env.WORKSPACE_MEMORY.get(env.WORKSPACE_MEMORY.idFromName(`wsmem:${orgId}`)) as unknown as MemoryRpc;
}

function indexStub(env: Env, orgId: string): ChatIndexRpc | null {
  if (!env.CHAT_INDEX) return null;
  return env.CHAT_INDEX.get(env.CHAT_INDEX.idFromName(`ws:${orgId}`)) as unknown as ChatIndexRpc;
}

/** The DX1 dispatch-shell DO's typed RPC (worker-side view). */
export interface DispatchIndexRpc {
  ring(section?: string): Promise<void>;
  shell(): Promise<{ cursor: string; counts: Record<string, number>; updatedAt: string | null }>;
}

function dispatchIndexStub(env: Env, orgId: string): DispatchIndexRpc | null {
  if (!env.DISPATCH_INDEX) return null;
  return env.DISPATCH_INDEX.get(env.DISPATCH_INDEX.idFromName(`wsdx:${orgId}`)) as unknown as DispatchIndexRpc;
}

export async function route(request: Request, env: Env, injectedDeps?: ChatDeps): Promise<Response> {
  const url = new URL(request.url);
  const reqId = requestId(request);
  const deps = injectedDeps ?? buildDeps(env);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return successResponse({ status: "ok", environment: env.ENVIRONMENT }, reqId);
    }

    const isChats =
      CHATS_RE.test(url.pathname) ||
      CHAT_RE.test(url.pathname) ||
      CHAT_TURN_RE.test(url.pathname) ||
      CHAT_AGUI_RUN_RE.test(url.pathname) ||
      CHAT_AGUI_WATCH_RE.test(url.pathname) ||
      MEMORY_RE.test(url.pathname) ||
      MEMORY_ENTRY_RE.test(url.pathname) ||
      DISPATCH_INDEX_RE.test(url.pathname);
    if (!isChats) return notFound(reqId, url.pathname);

    const actor = resolveActor(request);
    if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, reqId);

    // DX1 — the dispatch live layer: WS attach or the snapshot-first shell.
    let m0 = DISPATCH_INDEX_RE.exec(url.pathname);
    if (m0) {
      const orgId = uuidFromPublicId(m0[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (request.method !== "GET") return methodNotAllowed(reqId);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      if (!env.DISPATCH_INDEX) return errorResponse("unavailable", "Dispatch index not configured", 503, reqId);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const doStub = env.DISPATCH_INDEX.get(env.DISPATCH_INDEX.idFromName(`wsdx:${orgId}`));
        return doStub.fetch(new Request("https://dispatch/attach", request));
      }
      const idx = dispatchIndexStub(env, orgId)!;
      return successResponse(await idx.shell(), reqId);
    }

    // CX1 — the AG-UI run door: turn = run over SSE. Authorized like the turn
    // route (same grant, same owner-bearer requirement); the input's tools
    // must name registry entries only (the model's tool surface is code).
    let m = CHAT_AGUI_RUN_RE.exec(url.pathname);
    if (m) {
      const orgId = uuidFromPublicId(m[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (request.method !== "POST") return methodNotAllowed(reqId);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      if (!env.WORKSPACE_AGENT) return errorResponse("unavailable", "Chat not configured", 503, reqId);
      const ownerToken = request.headers.get("x-owner-bearer") || "";
      if (!ownerToken) return errorResponse("forbidden", "Run requires the owner credential", 403, reqId);
      let input: AguiRunInput;
      try {
        input = (await request.json()) as AguiRunInput;
      } catch {
        return errorResponse("validation_failed", "Invalid JSON", 400, reqId);
      }
      if (!validClientTools(input.tools)) {
        return errorResponse("validation_failed", "Unknown client tool — tools must name registry entries", 422, reqId);
      }
      const lastUser = [...(input.messages ?? [])].reverse().find((mm) => mm.role === "user");
      const text = (lastUser?.content ?? "").trim();
      if (!text) return errorResponse("validation_failed", "A user message is required", 400, reqId);
      const ns = env.WORKSPACE_AGENT;
      const doStub = ns.get(ns.idFromName(`chat:${m[2]!}`));
      const internal = new Request("https://chat/agui-run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          orgId,
          text,
          principal: actor.subjectId,
          ownerToken,
          ...(input.runId ? { runId: input.runId } : {}),
        }),
      });
      const res = await doStub.fetch(internal);
      // Touch the index + ring dispatch exactly as the turn route does —
      // fire-and-forget, never blocking the stream.
      const idx = indexStub(env, orgId);
      if (idx) void idx.touch(m[2]!, deps.now().toISOString()).catch(() => {});
      const dx = dispatchIndexStub(env, orgId);
      if (dx) void dx.ring("inFlight").catch(() => {});
      return res;
    }

    // CX1 — the AG-UI watch door: the passive SSE follower.
    m = CHAT_AGUI_WATCH_RE.exec(url.pathname);
    if (m) {
      const orgId = uuidFromPublicId(m[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (request.method !== "GET") return methodNotAllowed(reqId);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      if (!env.WORKSPACE_AGENT) return errorResponse("unavailable", "Chat not configured", 503, reqId);
      const from = url.searchParams.get("from") ?? "-1";
      const ns = env.WORKSPACE_AGENT;
      const doStub = ns.get(ns.idFromName(`chat:${m[2]!}`));
      return doStub.fetch(new Request(`https://chat/agui-watch?orgId=${encodeURIComponent(orgId)}&from=${encodeURIComponent(from)}`, { method: "GET", signal: request.signal }));
    }

    m = CHAT_TURN_RE.exec(url.pathname);
    if (m) {
      const orgId = uuidFromPublicId(m[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (request.method !== "POST") return methodNotAllowed(reqId);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      const stub = agentStub(env, m[2]!);
      if (!stub) return errorResponse("unavailable", "Chat not configured", 503, reqId);
      const ownerToken = request.headers.get("x-owner-bearer") || "";
      if (!ownerToken) return errorResponse("forbidden", "Turn requires the owner credential", 403, reqId);
      let body: { text?: string };
      try {
        body = (await request.json()) as { text?: string };
      } catch {
        return errorResponse("validation_failed", "Invalid JSON", 400, reqId);
      }
      const text = (body.text ?? "").trim();
      if (!text) return errorResponse("validation_failed", "text is required", 400, reqId);
      const result = await stub.turn(orgId, text, actor.subjectId, ownerToken);
      if (!result.ok && result.reason === "turn_in_progress") {
        return errorResponse("conflict", "A turn is already running in this thread", 409, reqId);
      }
      if (!result.ok && result.reason === "rate_limited") {
        return errorResponse("rate_limited", "This thread hit its turn rate ceiling — wait a moment", 429, reqId);
      }
      const idx = indexStub(env, orgId);
      if (idx) await idx.touch(m[2]!, deps.now().toISOString()).catch(() => {});
      // DX1 doorbell: a turn may have spawned/steered a session — tell every
      // dispatch head to refold. Coarse and fire-and-forget on purpose.
      const dx = dispatchIndexStub(env, orgId);
      if (dx && result.ok) await dx.ring("inFlight").catch(() => {});
      return successResponse({ accepted: true, ...result }, reqId, 202);
    }

    // The memory plane (AN6): list / edit / delete — no hidden memory, the
    // console sees exactly what the briefs read. Same chat grant.
    m = MEMORY_ENTRY_RE.exec(url.pathname);
    if (m) {
      const orgId = uuidFromPublicId(m[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      const mem = memoryStub(env, orgId);
      if (!mem) return errorResponse("unavailable", "Memory not configured", 503, reqId);
      if (request.method === "PATCH") {
        let body: { content?: string };
        try {
          body = (await request.json()) as { content?: string };
        } catch {
          return errorResponse("validation_failed", "Invalid JSON", 400, reqId);
        }
        const content = (body.content ?? "").trim();
        if (!content) return errorResponse("validation_failed", "content is required", 400, reqId);
        const updated = await mem.updateEntry(m[2]!, content);
        if (!updated) return notFound(reqId, url.pathname);
        return successResponse(updated, reqId);
      }
      if (request.method === "DELETE") {
        const deleted = await mem.deleteEntry(m[2]!);
        if (!deleted) return notFound(reqId, url.pathname);
        return successResponse({ deleted: true }, reqId);
      }
      return methodNotAllowed(reqId);
    }

    m = MEMORY_RE.exec(url.pathname);
    if (m) {
      const orgId = uuidFromPublicId(m[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      const mem = memoryStub(env, orgId);
      if (!mem) return errorResponse("unavailable", "Memory not configured", 503, reqId);
      if (request.method === "GET") return successResponse(await mem.listEntries(), reqId);
      return methodNotAllowed(reqId);
    }

    m = CHAT_RE.exec(url.pathname);
    if (m) {
      const orgId = uuidFromPublicId(m[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      const stub = agentStub(env, m[2]!);
      if (!stub) return errorResponse("unavailable", "Chat not configured", 503, reqId);
      if (request.method === "GET") {
        // The WS read plane: forward the upgrade to the DO (partyserver
        // handles the handshake → onConnect replay → live).
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const info = await stub.chatInfo();
          if (!info || info.orgId !== orgId) return notFound(reqId, url.pathname);
          const ns = env.WORKSPACE_AGENT!;
          const doStub = ns.get(ns.idFromName(`chat:${m[2]!}`));
          const qs = url.searchParams.get("from") ?? "-1";
          return doStub.fetch(new Request(`https://chat/attach?from=${qs}`, request));
        }
        const info = await stub.chatInfo();
        if (!info || info.orgId !== orgId) return notFound(reqId, url.pathname);
        const history = await stub.history(orgId);
        return successResponse({ id: info.chatId, title: info.title, createdAt: info.createdAt, messages: history }, reqId);
      }
      if (request.method === "DELETE") {
        // AN7 retention/deletion: the DO's storage IS the thread — after the
        // purge and the index removal, the thread is gone everywhere.
        const info = await stub.chatInfo();
        if (!info || info.orgId !== orgId) return notFound(reqId, url.pathname);
        await stub.destroyThread(orgId);
        const idx = indexStub(env, orgId);
        if (idx) await idx.removeChat(m[2]!).catch(() => {});
        return successResponse({ deleted: true }, reqId);
      }
      return methodNotAllowed(reqId);
    }

    m = CHATS_RE.exec(url.pathname);
    if (m) {
      const orgId = uuidFromPublicId(m[1]!, "org");
      if (!orgId) return notFound(reqId, url.pathname);
      if (!(await deps.authorize("organization.agent.chat", orgId, actor, reqId))) {
        return errorResponse("forbidden", "Not authorized", 403, reqId);
      }
      const idx = indexStub(env, orgId);
      if (!idx) return errorResponse("unavailable", "Chat not configured", 503, reqId);
      if (request.method === "GET") {
        return successResponse(await idx.listChats(), reqId);
      }
      if (request.method === "POST") {
        let body: { title?: string };
        try {
          body = (await request.json()) as { title?: string };
        } catch {
          body = {};
        }
        const chatId = deps.newChatId();
        const at = deps.now().toISOString();
        const title = (body.title ?? "").trim() || "New chat";
        const stub = agentStub(env, chatId);
        if (!stub) return errorResponse("unavailable", "Chat not configured", 503, reqId);
        await stub.initChat({ chatId, orgId, title, createdAt: at });
        await idx.register({ id: chatId, title, createdAt: at, lastAt: at });
        return successResponse({ id: chatId, title, createdAt: at }, reqId, 201);
      }
      return methodNotAllowed(reqId);
    }

    return notFound(reqId, url.pathname);
  } catch {
    return errorResponse("internal_error", "Internal error", 500, reqId);
  }
}
