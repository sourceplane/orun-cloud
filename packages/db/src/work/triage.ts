// Triage derivations (orun-work-v3 PM5; pure, unit-tested). One surface for
// everything that needs a HUMAN decision — all of it computed from the two
// logs on every read, none of it stored:
//
//   * review-parked  — merged work the fold honestly refuses to call Done
//     (gates unknown or red, P-7). The queue empties by facts arriving, not
//     by anyone clicking.
//   * mentions       — conversation that names a person/team.
//   * contract       — the agent-governance lane: a proposal is an agent- or
//     proposals        automation-actored contract_edited event (the MCP's
//                      contract_propose applies AND flags). It stays OPEN
//     until a human answers in the log: a later human contract_edited on
//     the same task (revert / supersede) or a human comment whose
//     payload.reviewsEvent names the proposal (accept). No flag column
//     exists — the review state IS a fold over the conversation.

import { extractMentions, type Actor, type Contract, type CoordinationEvent, type Lifecycle } from "./model.js";
import type { ContractEditedPayload, ItemCreatedPayload } from "./envelopes.js";

export interface ContractProposal {
  key: string;
  eventId: string;
  seq: number;
  at: string;
  proposedBy: Actor;
  /** The contract as proposed (in effect — proposals apply AND flag). */
  contract: Contract;
  /** What Revert restores: the contract in effect just before the proposal. */
  previousContract?: Contract | undefined;
}

/** Agent/automation contract edits not yet answered by a human, in log
 *  order. Events must be seq-ordered. */
export function openContractProposals(events: CoordinationEvent[]): ContractProposal[] {
  // Track the contract in effect per task as we replay, so each proposal
  // can carry what "revert" means at that point in history.
  const inEffect = new Map<string, Contract | undefined>();
  const open = new Map<string, ContractProposal>(); // eventId -> proposal

  for (const e of events) {
    if (e.kind === "item_created") {
      const p = e.payload as unknown as ItemCreatedPayload;
      if (p.kind === "Task") inEffect.set(p.key, p.contract);
      continue;
    }
    if (e.kind === "contract_edited") {
      const p = e.payload as unknown as ContractEditedPayload;
      if (e.actor.type === "user") {
        // A human touched the contract: every open proposal on this task is
        // answered (reverted or superseded by a human decision).
        for (const [id, prop] of open) {
          if (prop.key === e.subject) open.delete(id);
        }
      } else {
        open.set(e.eventId ?? String(e.seq), {
          key: e.subject,
          eventId: e.eventId ?? "",
          seq: e.seq,
          at: e.at,
          proposedBy: e.actor,
          contract: p.contract,
          previousContract: inEffect.get(e.subject),
        });
      }
      inEffect.set(e.subject, p.contract);
      continue;
    }
    if (e.kind === "comment_added" && e.actor.type === "user") {
      const p = e.payload as { reviewsEvent?: string } | undefined;
      if (p?.reviewsEvent) open.delete(p.reviewsEvent);
    }
  }

  return [...open.values()].sort((a, b) => a.seq - b.seq);
}

/** Tasks the fold parked In Review on merged evidence — honest degradation
 *  (P-7): the merge happened but the gates orun knows about aren't green. */
export function reviewParkedKeys(lifecycles: Record<string, Lifecycle>): string[] {
  return Object.values(lifecycles)
    .filter((lc) => lc.rung === "in_review" && (lc.evidence ?? []).some((e) => e.includes("merged")))
    .map((lc) => lc.key)
    .sort();
}

export interface Mention {
  key: string;
  eventId: string;
  at: string;
  by: Actor;
  handles: string[];
  body: string;
}

/** Comments that @mention someone, newest first, capped. */
export function recentMentions(events: CoordinationEvent[], limit = 20): Mention[] {
  const out: Mention[] = [];
  for (const e of events) {
    if (e.kind !== "comment_added") continue;
    const body = (e.payload as { body?: string } | undefined)?.body ?? "";
    const handles = extractMentions(body);
    if (handles.length === 0) continue;
    out.push({ key: e.subject, eventId: e.eventId ?? "", at: e.at, by: e.actor, handles, body });
  }
  return out.reverse().slice(0, limit);
}

/** Current assignees per task, folded from assigned/unassigned events —
 *  the PM5 seat model: an sp_ subject is an agent seat, assigned through
 *  the same mutator as anyone else. */
export function foldAssignees(events: CoordinationEvent[]): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.kind !== "assigned" && e.kind !== "unassigned") continue;
    const subjectId = (e.payload as { subjectId?: string } | undefined)?.subjectId;
    if (!subjectId) continue;
    const set = sets.get(e.subject) ?? new Set<string>();
    if (e.kind === "assigned") set.add(subjectId);
    else set.delete(subjectId);
    sets.set(e.subject, set);
  }
  const out = new Map<string, string[]>();
  for (const [key, set] of sets) {
    if (set.size > 0) out.set(key, [...set].sort());
  }
  return out;
}
