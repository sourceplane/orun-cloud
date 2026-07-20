// The anthropic-managed delegation interface (saas-dispatch DX7, design §10):
// a Claude Managed Agents cloud session spawned via API — the SECOND executor
// behind the one dispatch door. Beta surface `managed-agents-2026-04-01`;
// fetch-injectable so the whole adapter is fixture-testable; every failure is
// redacted to a status code (the Daytona adapter's discipline — a provider
// body may echo account details, so it never surfaces).
//
// v1 scope (recorded in the epic status): create agent + session, send the
// brief as the first user.message, interrupt/archive, and the EVENT
// TRANSLATION into the closed session-event vocabulary. The webhook ingest
// loop that feeds translated events through the relay is the remaining live
// slice — the state mapping below is what it will drive.

import type { SessionEventKind } from "@saas/db/agents";

const DEFAULT_API = "https://api.anthropic.com";
const BETA_HEADER = "managed-agents-2026-04-01";

export interface ManagedAgentsConfig {
  apiKey: string;
  /** Override for tests / gateways; default api.anthropic.com. */
  apiUrl?: string;
  fetchFn?: typeof fetch;
}

export interface ManagedSessionRef {
  provider: "anthropic-managed";
  agentId: string;
  sessionId: string;
}

export interface ManagedSpawnSpec {
  /** The profile's model (e.g. claude-opus-4-8). */
  model: string;
  /** The rendered system prompt (persona + literacy summary). */
  system: string;
  /** The definition-time tool narrowing (DX7's no-ask rule): the EXPLICIT
   * allowlist a managed agent runs with — there is no verdict channel, so
   * narrowing at definition time is the ONLY enforcement. */
  tools: string[];
  /** The first user message — the brief content. Nothing runs until sent. */
  brief: string;
  /** Display title (task key etc.). */
  title?: string;
}

function redact(status: number): string {
  return `${status} from provider`;
}

export class ManagedAgentsError extends Error {
  constructor(
    public step: string,
    message: string,
  ) {
    super(message);
    this.name = "ManagedAgentsError";
  }
}

export interface ManagedAgentsAdapter {
  /** agent + session + first message — returns the refs the sandbox JSONB
   * records. The two-step create (session provisions, first event runs) is
   * collapsed here because the dispatch door only spawns ready-to-run work. */
  spawn(spec: ManagedSpawnSpec): Promise<ManagedSessionRef>;
  /** Steer: a further user.message into the live session. */
  send(ref: ManagedSessionRef, text: string): Promise<void>;
  /** Interrupt → the control-plane `canceled` mapping. */
  interrupt(ref: ManagedSessionRef): Promise<void>;
  /** Archive (terminal cleanup; sessions are cattle here too). */
  archive(ref: ManagedSessionRef): Promise<void>;
}

export function createManagedAgentsAdapter(cfg: ManagedAgentsConfig): ManagedAgentsAdapter {
  const f = cfg.fetchFn ?? fetch;
  const base = (cfg.apiUrl ?? DEFAULT_API).replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-beta": BETA_HEADER,
  };

  async function post(step: string, path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await f(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch {
      throw new ManagedAgentsError(step, "provider unreachable");
    }
    if (!res.ok) throw new ManagedAgentsError(step, redact(res.status));
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ManagedAgentsError(step, "invalid provider response");
    }
  }

  return {
    async spawn(spec) {
      const agent = await post("agent.create", "/v1/agents", {
        name: spec.title ?? "orun-cloud managed run",
        model: spec.model,
        system: spec.system,
        // Definition-time narrowing (the no-ask rule): only the explicit
        // allowlist; an empty list means a tool-less reasoning session.
        tools: spec.tools.map((name) => ({ type: "mcp_toolset", mcp_server_name: name })),
      });
      const agentId = String(agent.id ?? "");
      if (!agentId) throw new ManagedAgentsError("agent.create", "invalid provider response");

      const session = await post("session.create", "/v1/sessions", {
        agent: agentId,
        ...(spec.title ? { title: spec.title } : {}),
      });
      const sessionId = String(session.id ?? "");
      if (!sessionId) throw new ManagedAgentsError("session.create", "invalid provider response");

      // The two-step contract: creating the session provisions; the first
      // user event starts the work.
      await post("event.send", `/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text: spec.brief }] }],
      });
      return { provider: "anthropic-managed", agentId, sessionId };
    },

    async send(ref, text) {
      await post("event.send", `/v1/sessions/${encodeURIComponent(ref.sessionId)}/events`, {
        events: [{ type: "user.message", content: [{ type: "text", text }] }],
      });
    },

    async interrupt(ref) {
      await post("session.interrupt", `/v1/sessions/${encodeURIComponent(ref.sessionId)}/interrupt`, {});
    },

    async archive(ref) {
      await post("session.archive", `/v1/sessions/${encodeURIComponent(ref.sessionId)}/archive`, {});
    },
  };
}

// ── Event translation (design §10.2) ────────────────────────────────────────
// Managed stream/webhook events → the CLOSED session-event vocabulary. There
// is deliberately no status kind on either side; `session.status_idle` maps
// to the completing transition, not to any work assertion.

export interface TranslatedEvent {
  kind: SessionEventKind;
  payload: Record<string, unknown>;
}

export function translateManagedEvent(e: { type?: string; [k: string]: unknown }): TranslatedEvent | null {
  switch (e.type) {
    case "agent.message":
      return { kind: "message_agent", payload: { via: "anthropic-managed" } };
    case "user.message":
      return { kind: "message_user", payload: { via: "anthropic-managed" } };
    case "agent.tool_use":
      return {
        kind: "tool_call",
        payload: { via: "anthropic-managed", ...(typeof e.name === "string" ? { tool: e.name } : {}) },
      };
    case "agent.tool_result":
      return { kind: "tool_result", payload: { via: "anthropic-managed" } };
    case "session.status_idle":
      // The done signal — the control plane advances running → completing →
      // completed off this; it is an infrastructure fact, never a work rung.
      return { kind: "state_changed", payload: { via: "anthropic-managed", signal: "idle" } };
    case "session.error":
      return { kind: "error", payload: { via: "anthropic-managed" } };
    default:
      // Unknown managed kinds drop rather than smuggle an open vocabulary
      // into the closed one (the DX5 sanitation posture).
      return null;
  }
}
