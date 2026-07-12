// Tree-transitive kill (saas-agents-fleet AF4, design §3.2): canceling any
// node cancels its subtree, children first (leaf-up), sandbox destroys
// best-effort — the sweep finishes stragglers, and durable truth is the
// sealed session, never the box. Killing the root is the fleet home's
// one-click "stop everything".

import type { AgentsDeps } from "../deps.js";
import type { ActorContext } from "../router.js";
import type { AgentSession } from "@saas/db/agents";
import { isTerminal } from "@saas/db/agents";
import { errorResponse, notFound, successResponse } from "../http.js";
import { destroySandbox } from "../sweep.js";

/** The subtree under (and including) `node`, leaf-up — children before
 * parents so no live child ever outranks a canceled parent mid-kill. */
export function subtreeLeafUp(node: AgentSession, sessions: AgentSession[]): AgentSession[] {
  const byParent = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    if (s.parentSessionId === undefined) continue;
    const list = byParent.get(s.parentSessionId) ?? [];
    list.push(s);
    byParent.set(s.parentSessionId, list);
  }
  const ordered: AgentSession[] = [];
  const walk = (n: AgentSession) => {
    for (const child of byParent.get(n.publicId) ?? []) walk(child);
    ordered.push(n);
  };
  walk(node);
  return ordered;
}

/** The one cancel edge a live state has; null when already terminal or the
 * state machine has no cancel path (completing finishes on its own). */
function cancelTarget(s: AgentSession): "canceled" | null {
  if (isTerminal(s.state) || s.state === "completing") return null;
  return "canceled";
}

export async function handleCancelSession(
  deps: AgentsDeps,
  orgId: string,
  sessionId: string,
  actor: ActorContext,
  requestId: string,
): Promise<Response> {
  // Killing a session is driving it — the interact grant (AL6 §2.2), the
  // sharpest permission in the product after approvals.
  if (!(await deps.authorize("organization.agent.session.interact", orgId, actor, requestId))) {
    return errorResponse("forbidden", "Not authorized", 403, requestId);
  }
  const scope = { orgId };
  const target = await deps.repo.getSession(scope, sessionId);
  if (!target) return notFound(requestId, sessionId);

  const sessions = await deps.repo.listSessions(scope);
  const subtree = subtreeLeafUp(target, sessions);

  let canceled = 0;
  let destroyed = 0;
  let skipped = 0;
  for (const node of subtree) {
    const to = cancelTarget(node);
    if (!to) {
      skipped++;
      continue;
    }
    try {
      if (await destroySandbox(deps, node, requestId, actor)) destroyed++;
    } catch {
      // Over-destroy posture (sweep discipline): a failed destroy never
      // blocks the cancel; the sweep collects the box later.
    }
    try {
      await deps.repo.advanceSession(scope, {
        publicId: node.publicId,
        to,
        sandbox: { ...node.sandbox, error: node.publicId === target.publicId ? "canceled" : "tree_killed" },
      });
      canceled++;
    } catch {
      // A racing terminal transition is fine — the node is dead either way.
      skipped++;
    }
  }

  return successResponse(
    { sessionId: target.publicId, canceled, destroyed, skipped, subtree: subtree.length },
    requestId,
  );
}
