// Pure helpers for the conversation surface (orun-work-v3 PM1; unit-tested,
// no React). Threads, reactions, and the timeline shape live here so the
// components stay thin.

import type { WorkEventView, WorkTimelineEntry } from "@saas/contracts/work";

export interface CommentNode {
  event: WorkEventView;
  replies: CommentNode[];
}

/** Groups comment_added events into threads: top-level comments in log
 *  order, replies nested under their parentEvent (one level — a reply to a
 *  reply nests under the same thread root's chain). Unknown parents render
 *  as top-level rather than vanish. */
export function groupThreads(events: WorkEventView[]): CommentNode[] {
  const comments = events.filter((e) => e.kind === "comment_added");
  const nodes = new Map<string, CommentNode>();
  for (const e of comments) nodes.set(e.eventId, { event: e, replies: [] });
  const roots: CommentNode[] = [];
  for (const e of comments) {
    const parent = (e.payload as { parentEvent?: string } | undefined)?.parentEvent;
    const node = nodes.get(e.eventId)!;
    if (parent && nodes.has(parent)) {
      nodes.get(parent)!.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/** Folds reaction_added/removed into per-comment emoji counts. A removal
 *  only cancels a prior add by the same actor (no negative counts). */
export function reactionCounts(events: WorkEventView[]): Map<string, Map<string, number>> {
  const byActor = new Map<string, Set<string>>(); // targetEvent → set of `${actor}:${emoji}`
  for (const e of events) {
    if (e.kind !== "reaction_added" && e.kind !== "reaction_removed") continue;
    const p = e.payload as { targetEvent?: string; emoji?: string } | undefined;
    if (!p?.targetEvent || !p.emoji) continue;
    const set = byActor.get(p.targetEvent) ?? new Set<string>();
    const token = `${e.actor.id}:${p.emoji}`;
    if (e.kind === "reaction_added") set.add(token);
    else set.delete(token);
    byActor.set(p.targetEvent, set);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [target, set] of byActor) {
    const counts = new Map<string, number>();
    for (const token of set) {
      const emoji = token.slice(token.indexOf(":") + 1);
      counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
    }
    if (counts.size > 0) out.set(target, counts);
  }
  return out;
}

/** One-line label for a timeline entry (the component renders chips around it). */
export function timelineLabel(entry: WorkTimelineEntry): string {
  if (entry.type === "observation" && entry.observation) {
    const o = entry.observation;
    return `${o.kind} · ${o.source}`;
  }
  const e = entry.event;
  if (!e) return "";
  if (e.kind === "comment_added") {
    const body = (e.payload as { body?: string } | undefined)?.body ?? "";
    return body.length > 120 ? `${body.slice(0, 120)}…` : body;
  }
  return e.kind.replace(/_/g, " ");
}
