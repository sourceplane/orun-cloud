import type { LaneHandler } from "./types.js";

/**
 * The events-owned lane handler registry (saas-event-streaming ES1).
 *
 * ES1 ships the dispatcher dark: the 'notifications' lane is registered
 * PAUSED in the lane table (590_webhooks_lane_adoption) and has no handler
 * until the ES2 rules engine lands here. The 'webhooks' lane never appears
 * in this registry — webhooks-worker owns and runs its own drain and shares
 * only the cursor storage.
 *
 * Tests exercise the dispatcher by injecting fake handlers directly.
 */
export function buildLaneHandlers(): LaneHandler[] {
  return [];
}
