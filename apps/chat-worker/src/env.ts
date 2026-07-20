// Bindings the chat-worker declares. The Workspace Agent is UNPRIVILEGED
// (saas-agents-native design §5.1/§8): no DB, no provisioning, no dispatch,
// no control-plane guts. Its two narrow seams are gates, not capabilities:
// POLICY_WORKER (deny-by-default authz) and CONFIG_WORKER (provider-key
// custody at turn time — the AG5 path; the key never lands in DO state).
// Every effect re-enters api-edge as a client with the owner's credential.

export interface Env {
  /** Membership worker — the actor's role assignments, fetched to build the
   * policy-evaluation context (part of the authz gate, not a capability: the
   * policy engine is pure and needs the caller's memberships to decide). */
  MEMBERSHIP_WORKER?: Fetcher;
  /** Policy worker — deny-by-default authorization (organization.agent.chat). */
  POLICY_WORKER?: Fetcher;
  /** Config worker — provider-key custody resolve (AG12/AG5 path). */
  CONFIG_WORKER?: Fetcher;
  /** api-edge service binding — the PUBLIC surface the agent is a client of
   * (providers list, MCP tool execution via the SDK). Same-credential
   * re-entry; no side doors. */
  API_EDGE?: Fetcher;
  /** Public api-edge origin for SDK base URLs (local dev / URL construction). */
  API_EDGE_URL?: string;
  /** Per-chat Workspace Agent DO (WorkspaceAgent, named chat:<chatId>). */
  WORKSPACE_AGENT?: DurableObjectNamespace;
  /** Per-workspace thread registry DO (ChatIndex, named ws:<orgId>). */
  CHAT_INDEX?: DurableObjectNamespace;
  /** Per-workspace memory DO (WorkspaceMemory, named wsmem:<orgId>) — the
   * AN6 provenanced memory plane. */
  WORKSPACE_MEMORY?: DurableObjectNamespace;
  /** Per-workspace dispatch shell DO (DispatchIndex, named wsdx:<orgId>) —
   * the saas-dispatch DX1 live layer: cursor watermark + section counts +
   * head fan-out. Holds no authorized content (DD7). */
  DISPATCH_INDEX?: DurableObjectNamespace;
  /** Deploy environment name. */
  ENVIRONMENT: string;
}
