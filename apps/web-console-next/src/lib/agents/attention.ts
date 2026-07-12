// Pure presentation model for the attention plane (saas-agents-fleet AF5).
// The queue's facts arrive computed from the worker's needs-you fold; this
// module only maps them to the Northwind grammar (tones, labels, durations).
// Dependency-free like model.ts so every mapping is unit-testable.

import type { AttentionItem, AttentionKind } from "@saas/contracts/agents";
import type { Tone } from "@/components/ui/northwind";

/** Queue-card tone by source kind: blocking asks are warnings (the verdict
 * wash), failures are errors, everything renders calm otherwise. */
export function attentionTone(kind: AttentionKind): Tone {
  switch (kind) {
    case "verdict":
    case "budget":
    case "routine_parked":
      return "warning";
    case "failed_retryable":
    case "stuck":
      return "error";
  }
}

export function attentionKindLabel(kind: AttentionKind): string {
  switch (kind) {
    case "verdict":
      return "Needs your verdict";
    case "budget":
      return "Budget mark";
    case "routine_parked":
      return "Routine parked";
    case "failed_retryable":
      return "Failed — retry available";
    case "stuck":
      return "Stuck";
  }
}

/** A verdict item is answerable in place (Approve/Deny post the same
 * attach-v1 frame the session page posts); everything else deep-links. */
export function isAnswerable(item: AttentionItem): boolean {
  return item.kind === "verdict" && !!item.request?.requestId;
}

/** "6m" / "2h" / "3d" — the mock's compact age column. */
export function compactAge(fromIso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** "48.2k" / "1.3M" — the mock's token column (AF8 spend on session rows). */
export function compactTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round((n / 1_000_000) * 10) / 10}M`;
}
