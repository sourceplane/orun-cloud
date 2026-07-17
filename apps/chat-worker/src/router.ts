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
import { uuidFromPublicId } from "@saas/db/ids";

const CHATS_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats$/;
const CHAT_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats\/([^/]+)$/;
const CHAT_TURN_RE = /^\/v1\/organizations\/([^/]+)\/agents\/chats\/([^/]+)\/turn$/;

interface Actor {
  subjectId: string;
  subjectType: string;
}

/** The typed RPC surfaces of the two DO classes (worker-side view). */
export interface WorkspaceAgentRpc {
  initChat(meta: ChatMeta): Promise<void>;
  chatInfo(): Promise<ChatMeta | null>;
  history(orgId: string): Promise<unknown[]>;
  turn(orgId: string, text: string, principal: string, ownerToken: string): Promise<{ ok: boolean; reason?: string }>;
}
export interface ChatIndexRpc {
  register(chat: ChatSummary): Promise<void>;
  touch(chatId: string, lastAt: string): Promise<void>;
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
      if (!env.POLICY_WORKER) return false;
      try {
        const res = await env.POLICY_WORKER.fetch("http://policy-worker/v1/internal/policy/authorize", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-id": requestId },
          body: JSON.stringify({
            orgId,
            action,
            subjectId: actor.subjectId,
            subjectType: actor.subjectType,
          }),
        });
        if (!res.ok) return false;
        const body = (await res.json()) as { data?: { allowed?: boolean } };
        return body.data?.allowed === true;
      } catch {
        return false;
      }
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

function indexStub(env: Env, orgId: string): ChatIndexRpc | null {
  if (!env.CHAT_INDEX) return null;
  return env.CHAT_INDEX.get(env.CHAT_INDEX.idFromName(`ws:${orgId}`)) as unknown as ChatIndexRpc;
}

export async function route(request: Request, env: Env, injectedDeps?: ChatDeps): Promise<Response> {
  const url = new URL(request.url);
  const reqId = requestId(request);
  const deps = injectedDeps ?? buildDeps(env);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return successResponse({ status: "ok", environment: env.ENVIRONMENT }, reqId);
    }

    const isChats = CHATS_RE.test(url.pathname) || CHAT_RE.test(url.pathname) || CHAT_TURN_RE.test(url.pathname);
    if (!isChats) return notFound(reqId, url.pathname);

    const actor = resolveActor(request);
    if (!actor) return errorResponse("unauthenticated", "Authentication required", 401, reqId);

    let m = CHAT_TURN_RE.exec(url.pathname);
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
      const idx = indexStub(env, orgId);
      if (idx) await idx.touch(m[2]!, deps.now().toISOString()).catch(() => {});
      return successResponse({ accepted: true, ...result }, reqId, 202);
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
