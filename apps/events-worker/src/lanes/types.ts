import type { StoredEvent } from "@saas/db/events";

/**
 * A lane handler processes events for one events-owned subscriber lane
 * (saas-event-streaming ES1). The dispatcher drives it: discovery says which
 * orgs have work, handleEvent processes exactly one event, and a throw marks
 * that event failed for this lane (bounded retries → dead letter).
 *
 * The 'webhooks' lane is NOT handled here — webhooks-worker owns and runs its
 * own drain; it shares only the cursor storage.
 */
export interface LaneHandler {
  laneKey: string;
  /** Orgs this lane currently has potential work for (small, indexed reads). */
  discoverOrgIds(): Promise<string[]>;
  /**
   * Process one event. MUST be idempotent per event — at-least-once dispatch
   * and replay both re-invoke it. Throwing marks the event failed.
   */
  handleEvent(event: StoredEvent): Promise<void>;
}
