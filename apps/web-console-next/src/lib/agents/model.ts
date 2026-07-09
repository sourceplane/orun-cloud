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

export const PROVIDER_META = {
  daytona: {
    name: "Daytona",
    blurb: "Sandbox compute your agent sessions run in. Connect your own Daytona account.",
    keyPlaceholder: "dtn_…",
    docsUrl: "https://www.daytona.io/docs/",
  },
  anthropic: {
    name: "Anthropic",
    blurb: "The model key injected into each session as ANTHROPIC_API_KEY — never stored on the session.",
    keyPlaceholder: "sk-ant-…",
    docsUrl: "https://docs.claude.com/en/api/getting-started",
  },
} as const;
