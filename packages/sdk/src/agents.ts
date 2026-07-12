// Agents resource client (saas-agents AG7) — the console's lens over the
// agent-session control plane: profiles, hosted sessions + their relayed
// event feed, and the workspace's BYO provider connections (AG12).
//
// Org-scoped: every method takes `orgId` first. Maps to `apps/agents-worker`
// via the api-edge `agents-facade`. The provider `connect` body carries the
// API key exactly once — it is never readable back through any method here
// (write-only-with-hint; `keyHint` is the display fact).

import type {
  AgentProfile,
  AgentSession,
  AgentSessionEventWire,
  AgentSessionState,
  AgentProvider,
  AttentionSummary,
  CreateAgentProfileRequest,
  CreateAgentSessionRequest,
  CreateProviderConnectionRequest,
  ProviderConnection,
} from "@saas/contracts/agents";

import type { Transport, RequestOptions } from "./transport.js";

function agentsBase(orgId: string): string {
  return `/v1/organizations/${encodeURIComponent(orgId)}/agents`;
}

export class AgentsClient {
  constructor(private readonly transport: Transport) {}

  // ── Profiles ────────────────────────────────────────────────

  /** GET /agents/profiles */
  listProfiles(orgId: string, opts: RequestOptions = {}): Promise<AgentProfile[]> {
    return this.transport.request<AgentProfile[]>(
      { method: "GET", path: `${agentsBase(orgId)}/profiles` },
      opts,
    );
  }

  /** POST /agents/profiles */
  createProfile(
    orgId: string,
    body: CreateAgentProfileRequest,
    opts: RequestOptions = {},
  ): Promise<AgentProfile> {
    return this.transport.request<AgentProfile>(
      { method: "POST", path: `${agentsBase(orgId)}/profiles`, body },
      opts,
    );
  }

  // ── Sessions ────────────────────────────────────────────────

  /** GET /agents/sessions?state= */
  listSessions(
    orgId: string,
    state?: AgentSessionState,
    opts: RequestOptions = {},
  ): Promise<AgentSession[]> {
    return this.transport.request<AgentSession[]>(
      { method: "GET", path: `${agentsBase(orgId)}/sessions`, query: { state } },
      opts,
    );
  }

  /** GET /agents/sessions/:id */
  getSession(orgId: string, sessionId: string, opts: RequestOptions = {}): Promise<AgentSession> {
    return this.transport.request<AgentSession>(
      { method: "GET", path: `${agentsBase(orgId)}/sessions/${encodeURIComponent(sessionId)}` },
      opts,
    );
  }

  /** POST /agents/sessions — spawnedBy is the caller, never the body. */
  createSession(
    orgId: string,
    body: CreateAgentSessionRequest,
    opts: RequestOptions = {},
  ): Promise<AgentSession> {
    return this.transport.request<AgentSession>(
      { method: "POST", path: `${agentsBase(orgId)}/sessions`, body },
      opts,
    );
  }

  /**
   * POST /agents/sessions/:id/provision — boot the sandbox on the workspace's
   * connected Daytona account (AG5). Refuses loud (`provider_connection_invalid`)
   * when a required provider connection is missing or unverified.
   */
  provisionSession(orgId: string, sessionId: string, opts: RequestOptions = {}): Promise<AgentSession> {
    return this.transport.request<AgentSession>(
      { method: "POST", path: `${agentsBase(orgId)}/sessions/${encodeURIComponent(sessionId)}/provision` },
      opts,
    );
  }

  /** GET /agents/sessions/:id/events — the relayed session-log mirror. */
  listSessionEvents(
    orgId: string,
    sessionId: string,
    opts: RequestOptions = {},
  ): Promise<AgentSessionEventWire[]> {
    return this.transport.request<AgentSessionEventWire[]>(
      { method: "GET", path: `${agentsBase(orgId)}/sessions/${encodeURIComponent(sessionId)}/events` },
      opts,
    );
  }

  /**
   * POST /agents/sessions/:id/input — a head input (steer/verdict/interrupt/
   * end) on a live session (saas-agents-live AL7). The frame is an attach-v1
   * head frame; the principal is stamped from the caller's bearer at the edge.
   * Returns the ack ({ ok, reason? }).
   */
  sendInput(
    orgId: string,
    sessionId: string,
    frame: Record<string, unknown>,
    opts: RequestOptions = {},
  ): Promise<{ v: number; t: string; ok?: boolean; reason?: string; ref?: string }> {
    return this.transport.request(
      { method: "POST", path: `${agentsBase(orgId)}/sessions/${encodeURIComponent(sessionId)}/input`, body: frame },
      opts,
    );
  }

  // ── The attention plane (saas-agents-fleet AF5) ─────────────

  /**
   * GET /agents/attention — the needs-you fold: verdicts waiting, budget
   * marks, parked routines, retryable failures, stuck sessions. Derived on
   * read (no stored inbox); acting on an item removes it by making its
   * source fact false.
   */
  attention(orgId: string, opts: RequestOptions = {}): Promise<AttentionSummary> {
    return this.transport.request<AttentionSummary>(
      { method: "GET", path: `${agentsBase(orgId)}/attention` },
      opts,
    );
  }

  // ── Provider connections (AG12) ─────────────────────────────

  /** GET /agents/providers?provider= */
  listProviders(
    orgId: string,
    provider?: AgentProvider,
    opts: RequestOptions = {},
  ): Promise<ProviderConnection[]> {
    return this.transport.request<ProviderConnection[]>(
      { method: "GET", path: `${agentsBase(orgId)}/providers`, query: { provider } },
      opts,
    );
  }

  /** POST /agents/providers — the apiKey transits exactly once. */
  connectProvider(
    orgId: string,
    body: CreateProviderConnectionRequest,
    opts: RequestOptions = {},
  ): Promise<ProviderConnection> {
    return this.transport.request<ProviderConnection>(
      { method: "POST", path: `${agentsBase(orgId)}/providers`, body },
      opts,
    );
  }

  /** POST /agents/providers/:id/verify — re-run the read-only provider ping. */
  verifyProvider(orgId: string, connectionId: string, opts: RequestOptions = {}): Promise<ProviderConnection> {
    return this.transport.request<ProviderConnection>(
      { method: "POST", path: `${agentsBase(orgId)}/providers/${encodeURIComponent(connectionId)}/verify` },
      opts,
    );
  }

  /** DELETE /agents/providers/:id — disconnect (key custody row remains until GC). */
  disconnectProvider(
    orgId: string,
    connectionId: string,
    opts: RequestOptions = {},
  ): Promise<{ deleted: boolean }> {
    return this.transport.request<{ deleted: boolean }>(
      { method: "DELETE", path: `${agentsBase(orgId)}/providers/${encodeURIComponent(connectionId)}` },
      opts,
    );
  }
}
