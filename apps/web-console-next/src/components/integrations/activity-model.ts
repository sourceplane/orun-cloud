/**
 * Pure view-model for a connection's Activity timeline (saas-integrations-console
 * IX5 polish). Merges the mint ledger + inbound delivery log into one
 * time-ordered timeline of colored-dot events (the mockup's Activity tab),
 * reusing the existing reads — no new backend. Dependency-free so the merge and
 * relative-time formatting are unit-testable.
 */

import type {
  PublicInboundDelivery,
  PublicMintedCredential,
} from "@saas/contracts/integrations";
import type { Tone } from "@/components/ui/northwind";

export interface TimelineEvent {
  id: string;
  /** Dot tone. */
  tone: Tone;
  title: string;
  /** Monospace detail (event ref / template / run), or "" for none. */
  detail: string;
  /** ISO-8601 timestamp the event sorts by. */
  at: string;
}

const MINT_TITLE: Record<string, string> = {
  api: "Token minted",
  secret_resolve: "Secret resolved",
  rotation: "Credential rotated",
};

/** One timeline event per minted credential (revocation supersedes the mint). */
function mintEvent(m: PublicMintedCredential): TimelineEvent {
  if (m.revokedAt) {
    return { id: `${m.id}:revoked`, tone: "neutral", title: "Credential revoked", detail: m.template, at: m.revokedAt };
  }
  const runRef = m.runId ? ` · run ${m.runId}` : "";
  return {
    id: m.id,
    tone: "info",
    title: MINT_TITLE[m.purpose] ?? "Token minted",
    detail: `${m.template}${runRef}`,
    at: m.mintedAt,
  };
}

const DELIVERY_BY_STATUS: Record<string, { title: string; tone: Tone }> = {
  emitted: { title: "Webhook delivered", tone: "success" },
  received: { title: "Webhook received", tone: "neutral" },
  failed: { title: "Delivery failed", tone: "error" },
  skipped: { title: "Delivery skipped", tone: "neutral" },
};

/** One timeline event per inbound delivery. */
function deliveryEvent(d: PublicInboundDelivery): TimelineEvent {
  const meta = DELIVERY_BY_STATUS[d.status] ?? { title: "Delivery", tone: "neutral" as Tone };
  const detail = `${d.eventType}${d.action ? `.${d.action}` : ""}`;
  return { id: d.id, tone: meta.tone, title: meta.title, detail, at: d.receivedAt };
}

/**
 * Merge mints + deliveries into one newest-first timeline. Invalid timestamps
 * sink to the bottom (treated as epoch) rather than throwing.
 */
export function mergeActivity(
  mints: readonly PublicMintedCredential[] | null | undefined,
  deliveries: readonly PublicInboundDelivery[] | null | undefined,
): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...(mints ?? []).map(mintEvent),
    ...(deliveries ?? []).map(deliveryEvent),
  ];
  const ts = (e: TimelineEvent) => {
    const t = new Date(e.at).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  return events.sort((a, b) => ts(b) - ts(a));
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now" / "5m ago" / "2h ago" / "yesterday" / "3d ago" / "Nov 12, 2025". */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = nowMs - t;
  if (diff < MIN) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "yesterday";
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
