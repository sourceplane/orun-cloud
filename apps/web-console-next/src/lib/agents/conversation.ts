// The relayed session-event wire shape (saas-agents-live AL7). The legacy
// console-head fold (foldConversation) that turned this stream into the old
// avatar/⌘-row ConversationView has been decommissioned — the cockpit
// (components/copilot/session-lens.tsx, sessionEventsToItems) is now the one
// renderer of the session log. This type stays because both the durable read
// (listSessionEvents) and the cockpit fold speak it.

import type { AgentSessionEventKind } from "@saas/contracts/agents";

/** One relayed session event (the wire shape from listSessionEvents / the SSE
 * event frame's payload). */
export interface ConversationEvent {
  seq: number;
  kind: AgentSessionEventKind | string;
  at?: string;
  payload?: Record<string, unknown>;
}
