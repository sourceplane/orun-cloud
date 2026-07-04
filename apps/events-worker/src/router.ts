import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleListAudit } from "./handlers/list-audit.js";
import { handleListDeadLetters, handleReplayDeadLetter } from "./handlers/dead-letters.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";
import { generateRequestId, isDeadLetterId, parseOrgPublicId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

export interface ActorContext {
  subjectId: string;
  subjectType: string;
}

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

function resolveActor(request: Request): ActorContext | null {
  const subjectId = request.headers.get("x-actor-subject-id");
  const subjectType = request.headers.get("x-actor-subject-type");
  if (!subjectId || !subjectType) return null;
  return { subjectId, subjectType };
}

const ORG_AUDIT_RE = /^\/v1\/organizations\/([^/]+)\/audit$/;
const ORG_DEAD_LETTERS_RE = /^\/v1\/organizations\/([^/]+)\/dead-letters$/;
const ORG_DEAD_LETTER_REPLAY_RE = /^\/v1\/organizations\/([^/]+)\/dead-letters\/([^/]+)\/replay$/;

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    const auditMatch = url.pathname.match(ORG_AUDIT_RE);
    if (auditMatch) {
      if (request.method !== "GET") {
        return methodNotAllowed(requestId);
      }

      const orgPublicId = auditMatch[1]!;
      const orgUuid = parseOrgPublicId(orgPublicId);
      if (!orgUuid) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }

      const actor = resolveActor(request);
      if (!actor) {
        return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      }

      return handleListAudit(request, env, requestId, actor, orgUuid);
    }

    const dlListMatch = url.pathname.match(ORG_DEAD_LETTERS_RE);
    if (dlListMatch) {
      if (request.method !== "GET") {
        return methodNotAllowed(requestId);
      }
      const orgUuid = parseOrgPublicId(dlListMatch[1]!);
      if (!orgUuid) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      const actor = resolveActor(request);
      if (!actor) {
        return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      }
      return handleListDeadLetters(request, env, requestId, actor, orgUuid);
    }

    const dlReplayMatch = url.pathname.match(ORG_DEAD_LETTER_REPLAY_RE);
    if (dlReplayMatch) {
      if (request.method !== "POST") {
        return methodNotAllowed(requestId);
      }
      const orgUuid = parseOrgPublicId(dlReplayMatch[1]!);
      const deadLetterId = dlReplayMatch[2]!;
      if (!orgUuid || !isDeadLetterId(deadLetterId)) {
        return errorResponse("not_found", "Not found", 404, requestId);
      }
      const actor = resolveActor(request);
      if (!actor) {
        return errorResponse("unauthenticated", "Authentication required", 401, requestId);
      }
      return handleReplayDeadLetter(request, env, requestId, actor, orgUuid, deadLetterId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
