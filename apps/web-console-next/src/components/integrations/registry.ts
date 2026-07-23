/**
 * The console's view of the Integration Registry (saas-integration-registry
 * IR1). Replaces the hardcoded `providers.ts` catalog: every provider fact
 * the hub and the spaces render — identity, category, connect posture,
 * entitlement, status — comes from the served `IntegrationDescriptor`s
 * (`client.integrations.getRegistry`), never from a console list.
 *
 * SP-A5 discipline applies: while the read is loading or failed, connect
 * entry points render disabled with a hint — NEVER a baked-in fallback
 * catalog (a silent stale fallback would reintroduce the hardcode as a
 * shadow).
 *
 * Pure helpers only (no React) so the grouping/state logic is
 * unit-testable; the hook lives beside them for the one-line consumers.
 */

import type {
  IntegrationCategory,
  IntegrationConnectMethod,
  IntegrationDescriptor,
  PublicConnection,
} from "@saas/contracts/integrations";

/** Hub section ordering (design §4). */
export const CATEGORY_ORDER: readonly IntegrationCategory[] = [
  "source-control",
  "messaging",
  "infrastructure",
  "ai-provider",
  "compute",
];

export const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  "source-control": "Source control",
  messaging: "Messaging",
  infrastructure: "Infrastructure",
  "ai-provider": "AI providers",
  compute: "Compute",
};

/** lucide icon name per provider id; category icon as the fallback so a new
 *  provider renders sensibly before anyone picks it a mark. */
const PROVIDER_ICON_NAMES: Record<string, string> = {
  github: "Github",
  slack: "MessageSquare",
  cloudflare: "Cloud",
  supabase: "Database",
  discord: "MessageCircle",
  aws: "Server",
};

const CATEGORY_ICON_NAMES: Record<IntegrationCategory, string> = {
  "source-control": "GitBranch",
  messaging: "MessageSquare",
  infrastructure: "Server",
  "ai-provider": "Sparkles",
  compute: "Cpu",
};

export function providerIconName(descriptor: IntegrationDescriptor): string {
  return PROVIDER_ICON_NAMES[descriptor.id] ?? CATEGORY_ICON_NAMES[descriptor.category] ?? "Plug";
}

export function descriptorById(
  registry: readonly IntegrationDescriptor[] | null | undefined,
  id: string,
): IntegrationDescriptor | null {
  return registry?.find((d) => d.id === id) ?? null;
}

/** Display name for a provider id; falls back to the id itself so labels
 *  degrade readably while the registry read is unavailable (SP-A5). */
export function providerDisplayName(
  registry: readonly IntegrationDescriptor[] | null | undefined,
  id: string,
): string {
  return descriptorById(registry, id)?.displayName ?? id;
}

/** Group descriptors into labeled category sections in CATEGORY_ORDER,
 *  dropping empty categories, preserving registry order within each. */
export function groupByCategory(
  descriptors: readonly IntegrationDescriptor[],
): Array<{ category: IntegrationCategory; label: string; items: IntegrationDescriptor[] }> {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    items: descriptors.filter((d) => d.category === category),
  })).filter((group) => group.items.length > 0);
}

/** The first environment-live connect method — what the console renders as
 *  the primary action; null = nothing connectable in this environment. */
export function primaryLiveConnect(
  descriptor: IntegrationDescriptor,
): IntegrationConnectMethod | null {
  return descriptor.connect.find((m) => m.live) ?? null;
}

/**
 * The uniform card state — a pure function of the descriptor + this org's
 * connections (design §4: no per-provider branches, ever):
 * - "connected": ≥1 active/pending connection (renders the connection card).
 * - "available": live, entitled (or unknown), and a live connect method.
 * - "locked":    live but the org's plan excludes it (renders upgrade CTA).
 * - "configure": live manifest, no env-ready connect method (honest gate).
 * - "roadmap":   non-interactive strip.
 */
export type IntegrationCardState =
  | "connected"
  | "available"
  | "locked"
  | "configure"
  | "roadmap";

export function cardState(
  descriptor: IntegrationDescriptor,
  connections: readonly PublicConnection[],
): IntegrationCardState {
  if (descriptor.status !== "live") return "roadmap";
  const connectedHere = connections.some(
    (c) => c.provider === descriptor.id && (c.status === "active" || c.status === "pending"),
  );
  if (connectedHere) return "connected";
  if (descriptor.entitled === false) return "locked";
  if (!primaryLiveConnect(descriptor)) return "configure";
  return "available";
}

/**
 * How connect starts for a descriptor (design §4/§5): a single live
 * install/oauth method keeps the hub's popup+poll flow; anything else —
 * token method, multiple methods — is owned by the provider's space, which
 * renders the full posture. Provider-generic: the `id === "cloudflare"`
 * special case this replaces must never come back.
 */
export type ConnectDispatch =
  | { kind: "popup" }
  | { kind: "space" }
  | { kind: "none" };

export function connectDispatch(descriptor: IntegrationDescriptor): ConnectDispatch {
  const liveMethods = descriptor.connect.filter((m) => m.live);
  if (liveMethods.length === 0) return { kind: "none" };
  if (
    liveMethods.length === 1 &&
    descriptor.connect.length === 1 &&
    (liveMethods[0]!.kind === "install" || liveMethods[0]!.kind === "oauth")
  ) {
    return { kind: "popup" };
  }
  return { kind: "space" };
}
