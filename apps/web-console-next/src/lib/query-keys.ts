/**
 * Stable react-query cache keys (Task 0130 / PERF1).
 *
 * Dependency-free (no React, no react-query) so the key composition is
 * unit-testable in isolation. One factory per resource; the id args already
 * encode the org/project scope, so keys never collide across resources, and
 * the same resource+scope always produces an equal key (shared cache entry).
 */
export const qk = {
  orgs: () => ["orgs"] as const,
  profile: () => ["profile"] as const,
  projects: (orgId: string) => ["projects", orgId] as const,
  orgLinks: (orgId: string) => ["orgLinks", orgId] as const,
  environments: (orgId: string, projectId: string) =>
    ["environments", orgId, projectId] as const,
  members: (orgId: string) => ["members", orgId] as const,
  teams: (orgId: string) => ["teams", orgId] as const,
  team: (orgId: string, teamId: string) => ["team", orgId, teamId] as const,
  teamMembers: (orgId: string, teamId: string) => ["teamMembers", orgId, teamId] as const,
  teamGrants: (orgId: string, teamId: string) => ["teamGrants", orgId, teamId] as const,
  ownerHandles: (orgId: string) => ["ownerHandles", orgId] as const,
  effectiveAccess: (orgId: string) => ["effectiveAccess", orgId] as const,
  invitations: (orgId: string) => ["invitations", orgId] as const,
  myInvitations: () => ["myInvitations"] as const,
  apiKeys: (orgId: string) => ["apiKeys", orgId] as const,
  cliSessions: () => ["cliSessions"] as const,
  cliGrant: (grantId: string) => ["cliGrant", grantId] as const,
  webhooks: (orgId: string) => ["webhooks", orgId] as const,
  webhookEndpoint: (orgId: string, endpointId: string) =>
    ["webhookEndpoint", orgId, endpointId] as const,
  notificationPrefs: (orgId: string) => ["notificationPrefs", orgId] as const,
  // saas-event-streaming ES6 — console surfaces for the event bus.
  events: (orgId: string, filterKey: string) => ["events", orgId, filterKey] as const,
  event: (orgId: string, eventId: string) => ["event", orgId, eventId] as const,
  eventGroups: (orgId: string, status: string) => ["eventGroups", orgId, status] as const,
  eventGroup: (orgId: string, groupId: string) => ["eventGroup", orgId, groupId] as const,
  notificationRules: (orgId: string) => ["notificationRules", orgId] as const,
  notificationChannels: (orgId: string) => ["notificationChannels", orgId] as const,
  deadLetters: (orgId: string, status: string) => ["deadLetters", orgId, status] as const,
  integrations: (orgId: string) => ["integrations", orgId] as const,
  /** One connection's detail read (saas-integration-hub IH8). */
  integration: (orgId: string, connectionId: string) =>
    ["integration", orgId, connectionId] as const,
  /** The credential-broker mint ledger for one connection (IH8). */
  mintedCredentials: (orgId: string, connectionId: string) =>
    ["mintedCredentials", orgId, connectionId] as const,
  /** Slack channels visible to a messaging connection's bot (IH8). */
  slackChannels: (orgId: string, connectionId: string) =>
    ["slackChannels", orgId, connectionId] as const,
  connectionGrants: (orgId: string, connectionId: string) =>
    ["connectionGrants", orgId, connectionId] as const,
  accountWorkspaces: (orgId: string) => ["accountWorkspaces", orgId] as const,
  accountMembers: (orgId: string) => ["accountMembers", orgId] as const,
  accountRoles: (orgId: string) => ["accountRoles", orgId] as const,
  repoLinks: (orgId: string, projectId: string) => ["repoLinks", orgId, projectId] as const,
  workspaceLinks: (orgId: string, projectId: string) =>
    ["workspaceLinks", orgId, projectId] as const,
  configSettings: (scopeKey: string) => ["configSettings", scopeKey] as const,
  configFlags: (scopeKey: string) => ["configFlags", scopeKey] as const,
  configSecrets: (scopeKey: string) => ["configSecrets", scopeKey] as const,
  orgCatalog: (orgId: string) => ["orgCatalog", orgId] as const,
  orgRuns: (orgId: string) => ["orgRuns", orgId] as const,
  orgWork: (orgId: string) => ["orgWork", orgId] as const,
  orgWorkRollups: (orgId: string, initiative: string) => ["orgWorkRollups", orgId, initiative] as const,
  orgWorkDesigns: (orgId: string, initiative: string) => ["orgWorkDesigns", orgId, initiative] as const,
  orgWorkDesign: (orgId: string, key: string) => ["orgWorkDesign", orgId, key] as const,
  orgWorkTimeline: (orgId: string, key: string) => ["orgWorkTimeline", orgId, key] as const,
  /** Agents surface (saas-agents AG7): the fleet-home composite (sessions +
   * profiles + attention + routines + records). Owned by the workbench — do
   * NOT reuse this key for a bare list, or a soft-nav cache hit hands a
   * consumer the wrong shape. */
  orgAgents: (orgId: string) => ["orgAgents", orgId] as const,
  /** Just the agent-profile list (AgentProfile[]) — the shape the session
   * detail + spawn dialog read. Kept distinct from `orgAgents` so its cache
   * entry is always the array, never the composite object. */
  orgAgentProfiles: (orgId: string) => ["orgAgentProfiles", orgId] as const,
  orgAgentSession: (orgId: string, sessionId: string) => ["orgAgentSession", orgId, sessionId] as const,
  orgAgentSessionEvents: (orgId: string, sessionId: string) =>
    ["orgAgentSessionEvents", orgId, sessionId] as const,
  /** Delegation tree (saas-agents-fleet AF4): the children strip. */
  orgAgentSessionChildren: (orgId: string, sessionId: string) =>
    ["orgAgentSessionChildren", orgId, sessionId] as const,
  /** BYO provider connections (AG12): Daytona + Anthropic cards. */
  orgAgentProviders: (orgId: string) => ["orgAgentProviders", orgId] as const,
  accountRuns: (orgId: string) => ["accountRuns", orgId] as const,
  repoFacets: (orgId: string) => ["repoFacets", orgId] as const,
  docObject: (orgId: string, projectId: string, digest: string) =>
    ["docObject", orgId, projectId, digest] as const,
  /** The whole org doc index (the Docs hub library, saas-catalog-docs CD5). */
  orgDocs: (orgId: string) => ["orgDocs", orgId] as const,
  /** One entity's doc set from the org doc index (saas-catalog-docs CD4). */
  entityDocs: (orgId: string, entityRef: string) => ["entityDocs", orgId, entityRef] as const,
  /** A doc body by content digest (immutable — cached indefinitely). */
  docBody: (orgId: string, digest: string) => ["docBody", orgId, digest] as const,
  catalogEntity: (orgId: string, entityKey: string) => ["catalogEntity", orgId, entityKey] as const,
  run: (orgId: string, projectId: string, runId: string) => ["run", orgId, projectId, runId] as const,
  runJobs: (orgId: string, projectId: string, runId: string) => ["runJobs", orgId, projectId, runId] as const,
  billingSummary: (orgId: string) => ["billingSummary", orgId] as const,
  entitlements: (orgId: string) => ["entitlements", orgId] as const,
  invoices: (orgId: string) => ["invoices", orgId] as const,
  gcReport: (orgId: string, projectId: string) => ["gcReport", orgId, projectId] as const,
};
