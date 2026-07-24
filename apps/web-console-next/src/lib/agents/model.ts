// Pure presentation model for the Agents surface (saas-agents AG7).
// Dependency-free so the tone/label mappings are unit-testable.

import type {
  AgentOrigin,
  AgentOriginKind,
  AgentSession,
  AgentSessionState,
  DelegationInterface,
  ProviderConnectionStatus,
} from "@saas/contracts/agents";
import { isTerminalSessionState } from "@saas/contracts/agents";
import type { Tone } from "@/components/ui/northwind";

/**
 * The origin chip (saas-agent-supervision SV0, design §2.3): one vocabulary for
 * WHO set an implementer running, rendered everywhere a session appears and,
 * on the Implementers surface, a filter facet. Colour is deliberately neutral —
 * the state pill owns the fleet's colour semantics; origin is provenance, not
 * status. A backfilled (inference, not door-recorded) origin renders muted.
 */
export interface OriginChip {
  /** The kicker: "Agent" | "Work" | "Routine" | "Session" | "Human". */
  kind: string;
  /** The full chip label, e.g. "Agent · Fix flaky CI" or "Human". */
  label: string;
  tone: Tone;
  /** Deep link to the origin (thread/work/parent session), when one exists. */
  href?: string;
  /** Inferred by the SV0 migration rather than recorded at the door. */
  backfilled: boolean;
  /** Hover text — the raw ref, for chips whose label is a friendlier name. */
  title?: string;
}

const ORIGIN_KICKERS: Record<AgentOrigin["kind"], string> = {
  dispatch: "Agent",
  work: "Work",
  routine: "Routine",
  session: "Session",
  human: "Human",
};

/** Shorten an id for display (`as_9f3c…`) so a chip never overflows its row. */
function shortRef(ref: string): string {
  return ref.length > 12 ? `${ref.slice(0, 10)}…` : ref;
}

/**
 * originChip — the pure presentation model for an origin, resolving its label
 * and deep link against the current workspace slug. Dependency-free + unit
 * tested; the React chip is a thin render over this.
 */
export function originChip(origin: AgentOrigin, orgSlug: string): OriginChip {
  const kind = ORIGIN_KICKERS[origin.kind] ?? "Human";
  const backfilled = origin.backfilled === true;
  const ref = origin.ref;
  const named = origin.label && origin.label.trim() ? origin.label.trim() : undefined;
  const detail = named ?? (ref ? shortRef(ref) : undefined);
  const label = detail ? `${kind} · ${detail}` : kind;
  const chip: OriginChip = { kind, label, tone: "neutral", backfilled };
  if (ref) chip.title = ref;
  // Deep links (design §2.3): the chip points back at the origin.
  if (ref) {
    switch (origin.kind) {
      case "dispatch":
        chip.href = `/orgs/${orgSlug}/agents/chat/${ref}`;
        break;
      case "session":
        chip.href = `/orgs/${orgSlug}/agents/${ref}`;
        break;
      case "work":
        chip.href = `/orgs/${orgSlug}/work`;
        break;
      // routine + human have no dedicated destination today — label-only.
    }
  }
  return chip;
}

/** Session states are infrastructure facts (design §4.1) — the tone reads
 * like a fleet dashboard, not a work board. */
export function sessionTone(state: AgentSessionState): Tone {
  switch (state) {
    case "running":
      return "success";
    case "requested":
    case "provisioning":
    case "completing":
      return "info";
    case "awaiting_approval":
    case "suspended":
      return "warning";
    case "failed":
    case "expired":
      return "error";
    case "completed":
    case "canceled":
      return "neutral";
  }
}

export function sessionLabel(state: AgentSessionState): string {
  switch (state) {
    case "awaiting_approval":
      return "Awaiting approval";
    default:
      return state.charAt(0).toUpperCase() + state.slice(1);
  }
}

export function connectionTone(status: ProviderConnectionStatus): Tone {
  switch (status) {
    case "verified":
      return "success";
    case "unverified":
      return "warning";
    case "invalid":
      return "error";
  }
}

/** The work:// pointer a spawned session carries back to its Work item
 * (AG8): provenance from session → item without restating work truth. */
export function workRefForItem(orgId: string, itemKey: string): string {
  return `work://${orgId}/${itemKey}`;
}

/** A fleet row with its tree placement (saas-agents-fleet AF4 §2.1). */
export interface FleetRow<S> {
  session: S;
  /** 0 for roots; children indent one gutter step per level. */
  depth: number;
}

/**
 * orderFleetRows groups delegation trees: every session appears exactly once,
 * children directly under their parent (input order preserved otherwise —
 * the caller sorts roots). A child whose parent is not in the input (e.g.
 * filtered into another section) renders as a root — never dropped.
 */
export function orderFleetRows<
  S extends { id: string; parentSessionId?: string },
>(sessions: S[]): FleetRow<S>[] {
  const present = new Set(sessions.map((s) => s.id));
  const children = new Map<string, S[]>();
  const roots: S[] = [];
  for (const s of sessions) {
    if (s.parentSessionId && present.has(s.parentSessionId)) {
      const list = children.get(s.parentSessionId) ?? [];
      list.push(s);
      children.set(s.parentSessionId, list);
    } else {
      roots.push(s);
    }
  }
  const out: FleetRow<S>[] = [];
  const walk = (s: S, depth: number) => {
    out.push({ session: s, depth });
    for (const child of children.get(s.id) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return out;
}

/** The orun agent types shipped in the base image (agents/*.md). A profile
 * binds one of these to a service principal (saas-agents §5). */
export const AGENT_TYPES = [
  { value: "implementer", label: "Implementer", blurb: "Works a task on a branch and opens a PR." },
  { value: "orchestrator", label: "Orchestrator", blurb: "Turns an epic into design + proposed contracts." },
] as const;

/** Models a profile can pin. The sandbox injects the workspace's selected
 * model-provider key at exec time (ANTHROPIC_API_KEY for Anthropic;
 * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN for gateway providers) and pins
 * the model via ANTHROPIC_MODEL. */
export const AGENT_MODELS = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { value: "claude-fable-5", label: "Claude Fable 5" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
] as const;

/** The only harness the base image ships today. */
export const DEFAULT_HARNESS = "claude-code";

/** The delegation interfaces a profile can ride (saas-dispatch DX7) — the
 * trust tier is RENDERED, never averaged (DD10): a Sealed run and a Managed
 * run must never look interchangeable. */
export const DELEGATION_INTERFACE_META = {
  "orun-sandbox": {
    label: "Sealed run",
    tone: "info" as const,
    blurb:
      "orun agent serve in your Daytona sandbox: content-addressed brief, replayable sealed record, mid-run approvals.",
  },
  "anthropic-managed": {
    label: "Managed run",
    tone: "warning" as const,
    blurb:
      "A Claude Managed Agents cloud session (beta): seconds to first token, definition-time tool narrowing only — no mid-run approvals, transcript record, Anthropic-managed runtime (not ZDR/HIPAA-eligible).",
  },
} as const;

export type DelegationInterfaceKey = keyof typeof DELEGATION_INTERFACE_META;

/** The tier pill for a profile's interface; unknown values render as sealed
 * (the conservative default — the prior behavior). */
export function interfaceTier(iface: string | undefined): {
  label: string;
  tone: "info" | "warning";
  blurb: string;
} {
  const meta = DELEGATION_INTERFACE_META[(iface ?? "orun-sandbox") as DelegationInterfaceKey];
  return meta ?? DELEGATION_INTERFACE_META["orun-sandbox"];
}

/** Build the canonical sp_ subject id from a service principal's raw UUID
 * (the shape api-keys list returns) — the profile's principalId. */
export function servicePrincipalSubjectId(uuid: string): string {
  return `sp_${uuid.replace(/-/g, "")}`;
}

export const PROVIDER_META = {
  daytona: {
    name: "Daytona",
    blurb: "Sandbox compute your agent sessions run in. Connect your own Daytona account.",
    keyPlaceholder: "dtn_…",
    modelPlaceholder: "",
    docsUrl: "https://www.daytona.io/docs/",
  },
  anthropic: {
    name: "Anthropic",
    blurb: "The Claude model key injected into each session as ANTHROPIC_API_KEY — never stored on the session.",
    keyPlaceholder: "sk-ant-…",
    modelPlaceholder: "claude-opus-4-8",
    docsUrl: "https://docs.claude.com/en/api/getting-started",
  },
  openai: {
    name: "OpenAI",
    blurb:
      "An OpenAI API key for model calls. Add a Base URL to point at a gateway — sessions need an Anthropic-compatible one.",
    keyPlaceholder: "sk-…",
    modelPlaceholder: "gpt-4o",
    docsUrl: "https://platform.openai.com/docs/api-reference",
  },
  openrouter: {
    name: "OpenRouter",
    blurb:
      "One OpenRouter key, many models. Set a Default model to pick one; sessions ride its Anthropic-compatible endpoint (https://openrouter.ai/api) automatically.",
    keyPlaceholder: "sk-or-…",
    modelPlaceholder: "anthropic/claude-sonnet-4.5",
    docsUrl: "https://openrouter.ai/docs",
  },
} as const;

/** Providers that accept an optional {baseUrl, defaultModel} in config — the
 * model-credential providers (Daytona takes apiUrl instead). */
export const MODEL_PROVIDER_SET = new Set(["anthropic", "openai", "openrouter"]);

/** The defaultModel a connection pins (OpenAI-compatible), else "". */
export function connectionModel(c: { config?: Record<string, unknown> }): string {
  const m = c.config?.defaultModel;
  return typeof m === "string" ? m.trim() : "";
}

/** Whether a VERIFIED model connection can actually route dispatch: Anthropic
 * ships a built-in default; OpenAI/OpenRouter need a pinned model id, so a
 * verified-but-modelless connection is a dead end the UI must call out. */
export function connectionReady(c: { provider: string; config?: Record<string, unknown> }): boolean {
  if (c.provider === "openai" || c.provider === "openrouter") return connectionModel(c).length > 0;
  return true;
}

/** The org setting naming the model connection agent SESSIONS boot with —
 * read by agents-worker at provision time. Keep in lockstep with
 * apps/agents-worker/src/handlers/provision.ts. */
export const SESSION_MODEL_SETTING_KEY = "agents.sessions.connection";

/** The mirror of DISPATCH_MODEL_SETTING_KEY for chat (chat-worker custody). */
export const DISPATCH_MODEL_SETTING_KEY = "agents.chat.connection";

/** The Base URL a connection pins, else "". */
export function connectionBaseUrl(c: { config?: Record<string, unknown> }): string {
  const u = c.config?.baseUrl;
  return typeof u === "string" ? u.trim() : "";
}

/** Whether a VERIFIED model connection can power a sandbox SESSION: Anthropic
 * rides natively; OpenRouter defaults to its Anthropic-compatible endpoint
 * (any openrouter.ai Base URL is canonicalized at provision); OpenAI needs an
 * explicit Anthropic-compatible gateway Base URL — keep in lockstep with
 * modelEnvForConnection in agents-worker's provision handler. */
export function connectionSessionReady(c: { provider: string; config?: Record<string, unknown> }): boolean {
  if (c.provider === "openai") return connectionBaseUrl(c).length > 0;
  return true;
}

/**
 * pickDispatchConnection — the console mirror of chat-worker custody's
 * selection rule (saas-dispatch DX-Q6), so Settings can show the model dispatch
 * will *actually* use, not just what's stored: the setting-named connection if
 * present + verified, else the sole verified model connection, else the one
 * named `default`, else null (ambiguous — the user must pick). Keep in lockstep
 * with apps/chat-worker/src/custody.ts:pickModelConnection.
 */
export function pickDispatchConnection<
  T extends { id?: string; name: string; provider: string; status: string },
>(connections: T[], preferredId?: string | null): T | null {
  const rows = connections.filter((c) => MODEL_PROVIDER_SET.has(c.provider) && c.status === "verified");
  if (rows.length === 0) return null;
  if (preferredId) {
    const chosen = rows.find((c) => c.id === preferredId);
    if (chosen) return chosen;
  }
  if (rows.length === 1) return rows[0]!;
  return rows.find((c) => c.name === "default") ?? null;
}

/** A model option the profile dialog offers. */
export interface ModelOption {
  value: string;
  label: string;
}

/**
 * modelOptions (saas-dispatch DX6): the profile dialog's model list becomes
 * connection-aware — the hardcoded `AGENT_MODELS` plus every VERIFIED model
 * connection that pins a `config.defaultModel`, labeled with its provider so
 * "which model does this delegation use" is answered where the key was
 * saved. Deduped by value; the static list wins the label on collision.
 */
export function modelOptions(
  connections: Array<{ provider: string; status: string; config?: Record<string, unknown> }>,
): ModelOption[] {
  const out: ModelOption[] = AGENT_MODELS.map((m) => ({ value: m.value, label: m.label }));
  const seen = new Set(out.map((m) => m.value));
  for (const c of connections) {
    if (!MODEL_PROVIDER_SET.has(c.provider) || c.status !== "verified") continue;
    const model = typeof c.config?.defaultModel === "string" ? c.config.defaultModel.trim() : "";
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const meta = PROVIDER_META[c.provider as keyof typeof PROVIDER_META];
    out.push({ value: model, label: `${model} · ${meta?.name ?? c.provider}` });
  }
  return out;
}

// ── Implementers facets (saas-agent-supervision SV4) ────────
// The Implementers surface (evolution of the fleet) is the full tainted list —
// every implementer regardless of origin or state — faceted by origin kind,
// infra state, interface tier, and needs-you. Pure predicates so the filter
// bar is a thin render and the matching is unit-tested (the hub-model idiom).

export type StateFacet = "all" | "active" | "terminal";

export interface FleetFacets {
  origin: AgentOriginKind | "all";
  state: StateFacet;
  tier: DelegationInterface | "all";
  /** When true, only implementers currently needing a human. */
  needsYou: boolean;
}

export const DEFAULT_FLEET_FACETS: FleetFacets = {
  origin: "all",
  state: "all",
  tier: "all",
  needsYou: false,
};

/** Context a facet match needs beyond the session row: the tier (from the
 * profile) and whether this session is on the needs-you fold (from attention). */
export interface FacetContext {
  interfaceOf: (profileId: string) => DelegationInterface | undefined;
  needsYou: (sessionId: string) => boolean;
}

/** sessionMatchesFacets — the pure predicate the Implementers list filters by.
 * Every facet is AND-combined; `all` / `false` are pass-through. */
export function sessionMatchesFacets(
  session: AgentSession,
  facets: FleetFacets,
  ctx: FacetContext,
): boolean {
  if (facets.origin !== "all" && session.origin.kind !== facets.origin) return false;
  if (facets.state !== "all") {
    const terminal = isTerminalSessionState(session.state);
    if (facets.state === "active" && terminal) return false;
    if (facets.state === "terminal" && !terminal) return false;
  }
  if (facets.tier !== "all") {
    const tier = ctx.interfaceOf(session.profileId) ?? "orun-sandbox";
    if (tier !== facets.tier) return false;
  }
  if (facets.needsYou && !ctx.needsYou(session.id)) return false;
  return true;
}

/** The origin kinds actually present in a fleet — render only the facets that
 * can match something (the presentCategories idiom). Ordered by ORIGIN_KICKERS. */
export function presentOriginKinds(sessions: AgentSession[]): AgentOriginKind[] {
  const present = new Set<AgentOriginKind>();
  for (const s of sessions) present.add(s.origin.kind);
  return (Object.keys(ORIGIN_KICKERS) as AgentOriginKind[]).filter((k) => present.has(k));
}

/** Are any non-default facets active? (drives the "clear filters" affordance). */
export function facetsActive(facets: FleetFacets): boolean {
  return (
    facets.origin !== "all" ||
    facets.state !== "all" ||
    facets.tier !== "all" ||
    facets.needsYou
  );
}
