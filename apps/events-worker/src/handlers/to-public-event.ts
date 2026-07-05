import type { PublicEvent } from "@saas/contracts/events";
import type { StoredEvent } from "@saas/db/events";
import {
  catalogEntryFor,
  effectiveEventSeverity,
  eventCategory,
  renderEventTitle,
} from "@saas/contracts/event-catalog";
import { toPublicId, toPublicScopeId } from "../ids.js";

/**
 * Redact a payload in place of a structural clone (shared with list-audit's
 * discipline): each `redactPaths` entry, normalized of a `$.`/`payload.` prefix,
 * has its terminal leaf replaced with `[REDACTED]`. Never throws on a missing
 * path.
 */
function redactPayload(payload: Record<string, unknown>, redactPaths: string[]): Record<string, unknown> {
  if (redactPaths.length === 0) return payload;
  const copy = structuredClone(payload);
  for (const rawPath of redactPaths) {
    let normalized = rawPath;
    if (normalized.startsWith("$.")) normalized = normalized.slice(2);
    if (normalized.startsWith("payload.")) normalized = normalized.slice(8);
    const parts = normalized.split(".");
    let target: Record<string, unknown> = copy;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      if (target[part] && typeof target[part] === "object" && !Array.isArray(target[part])) {
        target = target[part] as Record<string, unknown>;
      } else {
        target = undefined as unknown as Record<string, unknown>;
        break;
      }
    }
    if (target) {
      const lastKey = parts[parts.length - 1]!;
      if (lastKey in target) {
        target[lastKey] = "[REDACTED]";
      }
    }
  }
  return copy;
}

/**
 * Project a stored event onto the ES5 explorer's public read shape:
 * - `severity` is the catalog default escalated by a payload `severity` claim,
 * - `category` is the catalog category ("custom" for tenant events, "system"
 *   for anything unrecognized),
 * - `title` renders the catalog template; a custom event with no catalog title
 *   falls back to a string `payload.title`, else the type,
 * - scope + subject ids are re-encoded to their public forms,
 * - payload honors the row's `redactPaths`.
 */
export function toPublicEvent(e: StoredEvent): PublicEvent {
  const publicOrgId = toPublicScopeId("org_", e.orgId) ?? e.orgId;
  const payloadTitle = typeof e.payload["title"] === "string" ? (e.payload["title"] as string) : undefined;
  const titleTemplate = catalogEntryFor(e.type)?.title ?? payloadTitle ?? e.type;
  const title = renderEventTitle(titleTemplate, {
    subject: { kind: e.subjectKind, id: e.subjectId, name: e.subjectName },
    tenant: { orgId: publicOrgId },
    payload: e.payload,
  });

  return {
    id: e.id,
    type: e.type,
    version: e.version,
    source: e.source,
    severity: effectiveEventSeverity(e.type, e.payload),
    category: eventCategory(e.type),
    title,
    occurredAt: e.occurredAt.toISOString(),
    actor: {
      type: e.actorType as PublicEvent["actor"]["type"],
      id: e.actorId,
    },
    orgId: publicOrgId,
    projectId: toPublicScopeId("prj_", e.projectId),
    environmentId: toPublicScopeId("env_", e.environmentId),
    subject: {
      kind: e.subjectKind,
      id: toPublicId(e.subjectKind, e.subjectId),
      name: e.subjectName,
    },
    requestId: e.requestId,
    correlationId: e.correlationId,
    causationId: e.causationId,
    payload: redactPayload(e.payload, e.redactPaths),
  };
}
