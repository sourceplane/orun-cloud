"use client";

/**
 * Provider space modules (saas-integration-registry IR6, design §5.3) — the
 * "evolve in its own direction" seam. A module is a compact, titled Overview
 * section a provider's manifest declares (`space.modules`); the registry here
 * maps each `IntegrationModuleRef` onto a React component using the SP1 graft
 * pattern (side-effect registration at module load, last wins, fail-open):
 * an id nobody registered renders NOTHING — a manifest can declare a module
 * before the console ships it, and old consoles ignore new ids.
 *
 * Every module keeps the same discipline: a skeleton while its read loads, an
 * honest empty state, and a quiet "unavailable" card on error — a broken
 * module never breaks the space.
 *
 * READ-HOOK-ONLY CONVENTION (lint-enforceable): modules read through EXISTING
 * worker reads only — `useApiQuery` over SDK list/get calls — and a module
 * NEVER gets its own credential path. Nothing in this file may invoke a
 * write/mint/connect verb (`mintCredential`, `issueGithubToken`, `connect*`,
 * `create*`, `update*`, `revoke*`, `replay*`, …). If this ever needs teeth,
 * add a `no-restricted-syntax` entry scoped to this file matching
 * `CallExpression[callee.property.name=/^(mint|issue|connect|create|update|revoke|replay|delete)/]`.
 */

import * as React from "react";
import type {
  GetIntegrationResponse,
  IntegrationModuleRef,
  PublicConnection,
  PublicConnectionCustody,
} from "@saas/contracts/integrations";
import type { PublicNotificationChannel } from "@saas/contracts/notifications";
import type { AgentProvider, AgentSession } from "@saas/contracts/agents";
import { AGENT_PROVIDERS } from "@saas/contracts/agents";
import { Kicker, Pill, QuietLink, type Tone } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { connectionModel, connectionTone, sessionLabel, sessionTone } from "@/lib/agents/model";
import { connectionDisplayName } from "./connections";

// ---------------------------------------------------------------------------
// The registry (the SP1 graft pattern — see authoring-registry.ts)
// ---------------------------------------------------------------------------

/** What the space hands every module: identity + the already-loaded
 *  connection list (a module never re-fetches what the space has). */
export interface SpaceModuleProps {
  orgId: string;
  orgSlug: string;
  providerId: string;
  connections: readonly PublicConnection[];
}

export type SpaceModuleComponent = React.ComponentType<SpaceModuleProps>;

const SPACE_MODULES: Record<string, SpaceModuleComponent> = {};

/**
 * Register a module component for a `space.modules` ref. Module-load-time
 * registration; re-registering replaces (last wins). Returns an unregister
 * for tests.
 */
export function registerSpaceModule(
  moduleId: IntegrationModuleRef,
  component: SpaceModuleComponent,
): () => void {
  SPACE_MODULES[moduleId] = component;
  return () => {
    if (SPACE_MODULES[moduleId] === component) delete SPACE_MODULES[moduleId];
  };
}

/** The registered component for a module ref, or null (fail-open). */
export function spaceModuleFor(moduleId: IntegrationModuleRef): SpaceModuleComponent | null {
  return SPACE_MODULES[moduleId] ?? null;
}

/** True when a component is registered for the ref. */
export function hasSpaceModule(moduleId: IntegrationModuleRef): boolean {
  return moduleId in SPACE_MODULES;
}

/**
 * Resolve a manifest's declared module refs to renderable components,
 * preserving declaration order and DROPPING unknown ids (fail-open: a served
 * manifest may declare a module this console doesn't ship yet).
 */
export function resolveSpaceModules(
  refs: readonly IntegrationModuleRef[] | null | undefined,
): Array<{ id: IntegrationModuleRef; Component: SpaceModuleComponent }> {
  return (refs ?? []).flatMap((id) => {
    const Component = SPACE_MODULES[id];
    return Component ? [{ id, Component }] : [];
  });
}

/** The space's Overview mounts this once: every declared module, in order. */
export function SpaceModules({
  moduleRefs,
  ...props
}: SpaceModuleProps & { moduleRefs: readonly IntegrationModuleRef[] | null | undefined }) {
  const resolved = resolveSpaceModules(moduleRefs);
  if (resolved.length === 0) return null;
  return (
    <>
      {resolved.map(({ id, Component }) => (
        <Component key={id} {...props} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared chrome: every module is a titled card/section, never a page
// ---------------------------------------------------------------------------

function ModuleSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <Kicker className="mb-2.5">{title}</Kicker>
      {children}
    </section>
  );
}

function ModuleSkeleton() {
  return <Skeleton className="h-20 w-full rounded-xl" />;
}

/** Fail-soft: the quiet unavailable card — never an error wall. */
function ModuleUnavailable({ what }: { what: string }) {
  return (
    <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
      {what} — unavailable right now.
    </div>
  );
}

function ModuleEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">{children}</div>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Pure mappers (exported for tests — no React below this comment's scope)
// ---------------------------------------------------------------------------

/** The connection a single-connection-minded module reads through. */
export function firstActiveConnection(
  connections: readonly PublicConnection[],
): PublicConnection | null {
  return connections.find((c) => c.status === "active") ?? null;
}

/** GitHub repo grant ("all" | "selected", provider semantics) → copy. */
export function repoSelectionLabel(selection: string | null): string {
  if (selection === "all") return "All repositories in the account";
  if (selection === "selected") return "An allowlist of selected repositories";
  return "Repository selection unknown";
}

/** "12 repositories" / "50+ repositories" (truncated = provider had more). */
export function repoCountLabel(count: number, truncated: boolean): string {
  return `${count}${truncated ? "+" : ""} ${count === 1 && !truncated ? "repository" : "repositories"}`;
}

/** The notification channels that post through the Slack workspace bot. */
export function slackAppChannels(
  channels: readonly PublicNotificationChannel[],
): PublicNotificationChannel[] {
  return channels.filter((c) => c.kind === "slack_app");
}

/** Supabase project refs with custodied service keys — the safe `scopes`
 *  metadata on the `supabase_project_secret` custody row (never the keys). */
export function supabaseProjectRefs(
  custody: readonly PublicConnectionCustody[] | undefined,
): string[] {
  return (custody ?? [])
    .filter((row) => row.kind === "supabase_project_secret" && Array.isArray(row.scopes))
    .flatMap((row) => (row.scopes as unknown[]).filter((s): s is string => typeof s === "string"));
}

/** Custody health for a connection's custody summary (token_status-style):
 *  org-owned everywhere = healthy; any user-derived row = the SI1 warning. */
export function custodyHealth(
  custody: readonly PublicConnectionCustody[] | undefined,
): { label: string; tone: Tone } {
  const rows = custody ?? [];
  if (rows.length === 0) return { label: "no custody on record", tone: "neutral" };
  if (rows.some((r) => r.userDerived)) return { label: "user-derived custody", tone: "warning" };
  return { label: "org-owned custody", tone: "success" };
}

/** Most-recent-first sessions, capped — does not mutate the input. */
export function recentSessions(sessions: readonly AgentSession[], limit: number): AgentSession[] {
  return [...sessions]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, Math.max(0, limit));
}

/** Registry provider id → agents-plane provider id, when it is one. */
export function agentProviderFor(providerId: string): AgentProvider | null {
  return (AGENT_PROVIDERS as readonly string[]).includes(providerId)
    ? (providerId as AgentProvider)
    : null;
}

// ---------------------------------------------------------------------------
// repositories (GitHub): the org's linked-repo posture, read through the
// existing repo-browsing read (IG3) — client.integrations.listRepositories.
// ---------------------------------------------------------------------------

const REPO_PREVIEW_LIMIT = 5;

function RepositoriesModule({ orgId, orgSlug, connections }: SpaceModuleProps) {
  const { client } = useSession();
  const connection = firstActiveConnection(connections);
  const repos = useApiQuery(
    qk.integrationRepositories(orgId, connection?.id ?? "none"),
    () => wrap(() => client.integrations.listRepositories(orgId, connection!.id)),
    { enabled: connection !== null, staleTime: 60_000 },
  );

  return (
    <ModuleSection title="Repositories">
      {connection === null ? (
        <ModuleEmpty>Repositories appear once a GitHub connection is active.</ModuleEmpty>
      ) : repos.loading ? (
        <ModuleSkeleton />
      ) : repos.error ? (
        <ModuleUnavailable what="Repository list" />
      ) : (repos.data?.repositories.length ?? 0) === 0 ? (
        <ModuleEmpty>
          The installation can see no repositories yet — grant it repositories on GitHub, then they
          appear here.
        </ModuleEmpty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-5 py-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {repoCountLabel(repos.data!.repositories.length, repos.data!.truncated)}
            </span>
            <span>· {repoSelectionLabel(connection.repositorySelection)}</span>
          </div>
          {repos.data!.repositories.slice(0, REPO_PREVIEW_LIMIT).map((r) => (
            <div
              key={r.externalId}
              className="flex items-center gap-3 border-t border-border/50 px-5 py-2.5 text-sm first:border-t-0"
            >
              <span className="truncate font-mono text-[12px]">{r.fullName}</span>
              {r.private ? <Pill tone="neutral">private</Pill> : null}
              {r.defaultBranch ? (
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {r.defaultBranch}
                </span>
              ) : null}
            </div>
          ))}
          <div className="border-t border-border/50 px-5 py-3 text-xs text-muted-foreground">
            Repository linking and branch → environment maps live on each project&apos;s Git tab —{" "}
            <QuietLink href={`/orgs/${orgSlug}/projects`}>pick a project</QuietLink>.
          </div>
        </div>
      )}
    </ModuleSection>
  );
}

// ---------------------------------------------------------------------------
// channels (Slack): channels in use — the notification channels of kind
// `slack_app` (the ES3 channels read the settings page renders).
// ---------------------------------------------------------------------------

function ChannelsModule({ orgId, orgSlug }: SpaceModuleProps) {
  const { client } = useSession();
  const channels = useApiQuery(qk.notificationChannels(orgId), () =>
    wrap(async () => (await client.notificationChannels.list(orgId)).notificationChannels),
  );
  const inUse = slackAppChannels(channels.data ?? []);
  const pickerHref = `/orgs/${orgSlug}/settings/notifications/channels`;

  return (
    <ModuleSection title="Channels in use">
      {channels.loading ? (
        <ModuleSkeleton />
      ) : channels.error ? (
        <ModuleUnavailable what="Channel list" />
      ) : inUse.length === 0 ? (
        <ModuleEmpty>
          No channels post through the workspace bot yet —{" "}
          <QuietLink href={pickerHref}>pick channels</QuietLink> under Settings → Notifications.
        </ModuleEmpty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {inUse.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 border-t border-border/50 px-5 py-2.5 text-sm first:border-t-0"
            >
              <span className="truncate font-medium">{c.name}</span>
              {c.status && c.status !== "active" ? <Pill tone="warning">{c.status}</Pill> : null}
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {c.lastVerifiedAt ? `verified ${shortDate(c.lastVerifiedAt)}` : "not verified yet"}
              </span>
            </div>
          ))}
          <div className="border-t border-border/50 px-5 py-3 text-xs text-muted-foreground">
            Notifications post through these channels —{" "}
            <QuietLink href={pickerHref}>pick more channels</QuietLink>.
          </div>
        </div>
      )}
    </ModuleSection>
  );
}

// ---------------------------------------------------------------------------
// accounts (Cloudflare): per-connection account facts + custody health, from
// the same custody projection the connection detail renders (SI6) —
// client.integrations.get.
// ---------------------------------------------------------------------------

function AccountsModule({ orgId, orgSlug, providerId, connections }: SpaceModuleProps) {
  const active = connections.filter((c) => c.status === "active");
  return (
    <ModuleSection title="Accounts">
      {active.length === 0 ? (
        <ModuleEmpty>Account facts appear once a connection is active.</ModuleEmpty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {active.map((c) => (
            <AccountRow key={c.id} orgId={orgId} orgSlug={orgSlug} providerId={providerId} connection={c} />
          ))}
        </div>
      )}
    </ModuleSection>
  );
}

function AccountRow({
  orgId,
  orgSlug,
  providerId,
  connection,
}: {
  orgId: string;
  orgSlug: string;
  providerId: string;
  connection: PublicConnection;
}) {
  const { client } = useSession();
  // Same key + shape as the connection detail page (GetIntegrationResponse).
  const detail = useApiQuery<GetIntegrationResponse>(qk.integration(orgId, connection.id), () =>
    wrap(() => client.integrations.get(orgId, connection.id)),
  );
  const health = custodyHealth(detail.data?.custody);

  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border/50 px-5 py-3 text-sm first:border-t-0">
      <span className="font-medium">{connectionDisplayName(connection)}</span>
      {connection.externalAccountLogin ? (
        <span className="font-mono text-[11px] text-muted-foreground">
          {connection.externalAccountLogin}
        </span>
      ) : null}
      {detail.loading ? (
        <Skeleton className="h-5 w-28 rounded-full" />
      ) : detail.error ? (
        <span className="text-[11px] text-muted-foreground">custody unavailable</span>
      ) : (
        <Pill tone={health.tone} dot>
          {health.label}
        </Pill>
      )}
      <span className="ml-auto">
        <QuietLink href={`/orgs/${orgSlug}/integrations/${providerId}/connections/${connection.id}`}>
          Custody &amp; grants
        </QuietLink>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// projects (Supabase): projects with custodied service keys, from the same
// custody projection (the `supabase_project_secret` row's safe `scopes`
// metadata). The full cached {ref, name} project inventory is captured at
// connect but NOT client-readable yet — that read lands with the provider
// facts projection, so the empty state says so honestly.
// ---------------------------------------------------------------------------

function ProjectsModule({ orgId, connections }: SpaceModuleProps) {
  const { client } = useSession();
  const connection = firstActiveConnection(connections);
  const detail = useApiQuery<GetIntegrationResponse>(
    qk.integration(orgId, connection?.id ?? "none"),
    () => wrap(() => client.integrations.get(orgId, connection!.id)),
    { enabled: connection !== null },
  );
  const refs = supabaseProjectRefs(detail.data?.custody);

  return (
    <ModuleSection title="Projects">
      {connection === null ? (
        <ModuleEmpty>Projects appear once a Supabase connection is active.</ModuleEmpty>
      ) : detail.loading ? (
        <ModuleSkeleton />
      ) : detail.error ? (
        <ModuleUnavailable what="Project facts" />
      ) : refs.length === 0 ? (
        <ModuleEmpty>
          No project facts yet — the cached project list lands with the provider facts projection.
          Projects appear here once service keys are custodied at connect.
        </ModuleEmpty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b border-border/50 px-5 py-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {refs.length} project{refs.length === 1 ? "" : "s"}
            </span>{" "}
            · service keys custodied at connect (keys never surface here)
          </div>
          {refs.map((ref) => (
            <div
              key={ref}
              className="border-t border-border/50 px-5 py-2.5 font-mono text-[12px] first:border-t-0"
            >
              {ref}
            </div>
          ))}
        </div>
      )}
    </ModuleSection>
  );
}

// ---------------------------------------------------------------------------
// models (Anthropic / OpenAI / OpenRouter): key hint, verification status,
// last-verified, default model — the agents-plane provider read (AG12),
// client.agents.listProviders.
// ---------------------------------------------------------------------------

function ModelsModule({ orgId, orgSlug, providerId }: SpaceModuleProps) {
  const { client } = useSession();
  const provider = agentProviderFor(providerId);
  // The shared AG12 key: other consumers cache the full list, so read the
  // full list and filter client-side (a shared key must cache one shape).
  const providers = useApiQuery(
    qk.orgAgentProviders(orgId),
    () => wrap(() => client.agents.listProviders(orgId)),
    { enabled: provider !== null },
  );
  const keys = (providers.data ?? []).filter((c) => c.provider === provider);
  const settingsHref = `/orgs/${orgSlug}/settings/ai-providers`;

  if (provider === null) return null;
  return (
    <ModuleSection title="Models">
      {providers.loading ? (
        <ModuleSkeleton />
      ) : providers.error ? (
        <ModuleUnavailable what="Key status" />
      ) : keys.length === 0 ? (
        <ModuleEmpty>No keys connected yet — connect one to serve models to agent sessions.</ModuleEmpty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          {keys.map((k) => {
            const model = connectionModel(k);
            return (
              <div
                key={k.id}
                className="flex flex-wrap items-center gap-3 border-t border-border/50 px-5 py-2.5 text-sm first:border-t-0"
              >
                <span className="font-medium">{k.name}</span>
                {k.keyHint ? (
                  <span className="font-mono text-[11px] text-muted-foreground">{k.keyHint}</span>
                ) : null}
                <Pill tone={connectionTone(k.status)} dot>
                  {k.status}
                </Pill>
                <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {model ? (
                    <span className="font-mono">{model}</span>
                  ) : (
                    "provider default model"
                  )}
                  {k.lastVerifiedAt ? ` · verified ${shortDate(k.lastVerifiedAt)}` : ""}
                </span>
              </div>
            );
          })}
          <div className="border-t border-border/50 px-5 py-3 text-xs text-muted-foreground">
            Which key sessions, dispatch, and copilot use lives in{" "}
            <QuietLink href={settingsHref}>Settings → AI providers</QuietLink>.
          </div>
        </div>
      )}
    </ModuleSection>
  );
}

// ---------------------------------------------------------------------------
// sandboxes (Daytona): recent agent sessions — sandboxes run per session —
// from the agents-plane session list read, client.agents.listSessions.
// ---------------------------------------------------------------------------

const SESSION_PREVIEW_LIMIT = 5;

function SandboxesModule({ orgId, orgSlug }: SpaceModuleProps) {
  const { client } = useSession();
  const sessions = useApiQuery(qk.orgAgentSessions(orgId), () =>
    wrap(() => client.agents.listSessions(orgId)),
  );
  const recent = recentSessions(sessions.data ?? [], SESSION_PREVIEW_LIMIT);
  const agentsHref = `/orgs/${orgSlug}/agents`;

  return (
    <ModuleSection title="Sandboxes">
      {sessions.loading ? (
        <ModuleSkeleton />
      ) : sessions.error ? (
        <ModuleUnavailable what="Session list" />
      ) : recent.length === 0 ? (
        <ModuleEmpty>
          No agent sessions yet — a sandbox boots per session on this account. Spawn one from the{" "}
          <QuietLink href={agentsHref}>Agents tab</QuietLink>.
        </ModuleEmpty>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="border-b border-border/50 px-5 py-3 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {sessions.data!.length} session{sessions.data!.length === 1 ? "" : "s"}
            </span>{" "}
            · most recent first
          </div>
          {recent.map((s) => (
            <a
              key={s.id}
              href={`${agentsHref}/${s.id}`}
              className="flex items-center gap-3 border-t border-border/50 px-5 py-2.5 text-sm first:border-t-0 hover:bg-muted/40"
            >
              <span className="font-mono text-[12px]">{s.taskKey ?? s.id}</span>
              <Pill tone={sessionTone(s.state)} dot>
                {sessionLabel(s.state)}
              </Pill>
              <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                {shortDate(s.createdAt)}
              </span>
            </a>
          ))}
          <div className="border-t border-border/50 px-5 py-3 text-xs text-muted-foreground">
            The full fleet — attention, routines, records — lives on the{" "}
            <QuietLink href={agentsHref}>Agents tab</QuietLink>.
          </div>
        </div>
      )}
    </ModuleSection>
  );
}

// ---------------------------------------------------------------------------
// Built-in registrations (side effect at module load — the space imports this
// file, so every declared ref below resolves; new refs fail open to nothing).
// ---------------------------------------------------------------------------

registerSpaceModule("repositories", RepositoriesModule);
registerSpaceModule("channels", ChannelsModule);
registerSpaceModule("accounts", AccountsModule);
registerSpaceModule("projects", ProjectsModule);
registerSpaceModule("models", ModelsModule);
registerSpaceModule("sandboxes", SandboxesModule);
