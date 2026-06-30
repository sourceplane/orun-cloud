import type { PublicOrganization } from "@saas/contracts/membership";

export interface WorkspaceIdCard {
  /** Stable kind: the durable `ws_…` id vs the legacy `org_<hex>` id. */
  kind: "durable" | "legacy";
  title: string;
  /** The id value rendered (mono) + copied. */
  value: string;
}

/**
 * The Workspace-ID cards shown on the org settings page (WID5): lead with the
 * durable `ws_…` (`workspaceRef`) when present, then the legacy `org_<hex>` id
 * relabeled as legacy. The durable card is omitted on older payloads that lack
 * `workspaceRef`, so the legacy id is never hidden.
 */
export function workspaceIdCards(
  org: Pick<PublicOrganization, "id" | "workspaceRef">,
): WorkspaceIdCard[] {
  const cards: WorkspaceIdCard[] = [];
  if (org.workspaceRef) {
    cards.push({ kind: "durable", title: "Workspace ID", value: org.workspaceRef });
  }
  cards.push({ kind: "legacy", title: "Legacy Workspace ID", value: org.id });
  return cards;
}
