// Pure presentation model for the Agents surface (saas-agents AG7).
// Dependency-free so the tone/label mappings are unit-testable.

import type { AgentSessionState, ProviderConnectionStatus } from "@saas/contracts/agents";
import type { Tone } from "@/components/ui/northwind";

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

/** Models a profile can pin. The sandbox injects the workspace's Anthropic key
 * as ANTHROPIC_API_KEY; the runtime reads the model from the profile. */
export const AGENT_MODELS = [
  { value: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { value: "claude-fable-5", label: "Claude Fable 5" },
  { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
] as const;

/** The only harness the base image ships today. */
export const DEFAULT_HARNESS = "claude-code";

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
    docsUrl: "https://www.daytona.io/docs/",
  },
  anthropic: {
    name: "Anthropic",
    blurb: "The Claude model key injected into each session as ANTHROPIC_API_KEY — never stored on the session.",
    keyPlaceholder: "sk-ant-…",
    docsUrl: "https://docs.claude.com/en/api/getting-started",
  },
  openai: {
    name: "OpenAI",
    blurb: "An OpenAI API key for model calls. Add a Base URL to point at an OpenAI-compatible gateway.",
    keyPlaceholder: "sk-…",
    docsUrl: "https://platform.openai.com/docs/api-reference",
  },
  openrouter: {
    name: "OpenRouter",
    blurb: "One OpenRouter key, many models. OpenAI-compatible — set a Default model to pick one.",
    keyPlaceholder: "sk-or-…",
    docsUrl: "https://openrouter.ai/docs",
  },
} as const;

/** Providers that accept an optional {baseUrl, defaultModel} in config — the
 * model-credential providers (Daytona takes apiUrl instead). */
export const MODEL_PROVIDER_SET = new Set(["anthropic", "openai", "openrouter"]);

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
