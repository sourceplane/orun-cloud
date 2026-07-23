"use client";

// The per-connection detail page (saas-integration-hub IH8, design §6
// "Connection detail, per archetype"). One shared header + danger zone; the
// body branches by provider archetype:
//
//   - messaging (Slack): workspace facts, channels the bot can post to, and
//     the admission panel for account-shared connections.
//   - infrastructure (Cloudflare/Supabase): account facts, the scope-template
//     catalog (the scoped credentials this connection can provide), and the
//     "Create scoped credential" flow that binds a run-time secret to it.
//   - source-control (GitHub): deliberately minimal — facts + a pointer to the
//     per-project Git tab (design: "GitHub: unchanged") + admission panel.

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Cloud,
  Database,
  GitBranch,
  Hash,
  Lock,
  MessageSquare,
  Plug,
  type LucideIcon,
} from "lucide-react";
import type {
  GetIntegrationResponse,
  PublicConnectionCustody,
} from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { AttentionBanner, Kicker, Pill, QuietLink, Screen, type Tone } from "@/components/ui/northwind";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  connectionDisplayName,
  connectionProviderName,
  connectionScopeMeta,
  connectionShareModeMeta,
  connectionStatusMeta,
  isReferenceCheckUnavailable,
  parseRevokeBlockers,
  reauthAffordance,
  uninstallDisclosure,
  type RevokeBlocker,
} from "@/components/integrations/connections";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { archetypeForProvider } from "@/components/integrations/archetype";
import { templatesForProvider } from "@/components/config/bind-secret-flow";
import { providerSpaceCreateHref } from "@/components/integrations/provider-space-lib";
import { ConnectionAdmission } from "@/components/integrations/connection-admission";

/** Badge tone (connections.ts) → Northwind pill tone (mirrors the hub). */
const STATUS_TONE: Record<string, Tone> = {
  default: "neutral",
  success: "success",
  warning: "warning",
  destructive: "error",
};

const PROVIDER_ICONS: Record<string, LucideIcon> = {
  github: GitBranch,
  slack: MessageSquare,
  cloudflare: Cloud,
  supabase: Database,
};

export function ConnectionDetail({
  orgId,
  orgSlug,
  connectionId,
}: {
  orgId: string;
  orgSlug: string;
  connectionId: string;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const hubHref = `/orgs/${orgSlug}/integrations`;

  // `useApiQuery` narrows errors to { code, message }; keep the full body
  // alongside so the load-error card can show the requestId (design §6:
  // "error with requestId").
  const lastLoadError = React.useRef<{ error: ApiErrorBody; status: number } | null>(null);
  const conn = useApiQuery<GetIntegrationResponse>(qk.integration(orgId, connectionId), async () => {
    const r = await wrap(async () => client.integrations.get(orgId, connectionId));
    lastLoadError.current = r.ok ? null : { error: r.error, status: r.status };
    return r;
  });

  // SP0c (SP-A1): the "credential types" table derives from the bulk
  // capability read — the console no longer mirrors the worker catalogs.
  const capabilitiesQuery = useApiQuery(
    qk.secretsCapabilities(orgId),
    () => wrap(async () => (await client.integrations.listSecretsCapabilities(orgId)).capabilities),
    { staleTime: 10 * 60_000 },
  );

  const [revokeOpen, setRevokeOpen] = React.useState(false);
  // brokered-orphan-safety (Feature 2): the referential guard blocks a revoke
  // while active brokered secrets still bind to this connection. On a 409 we
  // switch from the plain confirm to a blocked dialog that names the secrets
  // and offers the explicit force path (which orphans them).
  const [blocked, setBlocked] = React.useState<{ blockers: RevokeBlocker[]; unavailable: boolean } | null>(null);
  const [forcing, setForcing] = React.useState(false);

  if (conn.loading) {
    return (
      <Screen>
        <div className="space-y-4 pt-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-[120px] w-full rounded-xl" />
          <Skeleton className="h-[220px] w-full rounded-xl" />
        </div>
      </Screen>
    );
  }

  if (conn.error) {
    const failure = lastLoadError.current;
    // An unknown or foreign connection id 404s — render the honest empty state
    // with a way back, not an error card.
    if (failure?.status === 404 || conn.error.code === "not_found") {
      return (
        <Screen>
          <EmptyState
            icon={Plug}
            title="Connection not found"
            description="This connection doesn't exist in this organization — it may have been revoked, or the link points at another workspace's connection."
            primaryAction={{ label: "Back to Integrations", href: hubHref }}
          />
        </Screen>
      );
    }
    return (
      <Screen>
        <QuietLink href={hubHref}>← Integrations</QuietLink>
        <div className="mt-4 rounded-xl border bg-card px-6 py-5">
          <div className="text-[13.5px] font-medium text-destructive">Failed to load the connection</div>
          <div className="mt-1 text-xs text-muted-foreground">{conn.error.message}</div>
          {failure?.error.requestId ? (
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">
              requestId: {failure.error.requestId}
            </div>
          ) : null}
          <Button size="sm" variant="outline" className="mt-3" onClick={() => conn.reload()}>
            Retry
          </Button>
        </div>
      </Screen>
    );
  }

  const connection = conn.data?.connection;
  if (!connection) return null;
  const custody = conn.data?.custody ?? [];

  const archetype = archetypeForProvider(connection.provider);
  const providerName = connectionProviderName(connection);
  const statusMeta = connectionStatusMeta(connection.status);
  const scopeMeta = connectionScopeMeta(connection.scope);
  const shareMeta = connectionShareModeMeta(connection);
  const Icon = PROVIDER_ICONS[connection.provider] ?? Plug;
  const templates = templatesForProvider(capabilitiesQuery.data ?? [], connection.provider);
  const isActive = connection.status === "active";
  const showAdmission = isActive && connection.scope === "account" && !connection.inherited;
  // IH9 re-auth CTA (design §5.3): a suspended oauth/token-kind connection is
  // fixed by re-running the provider's connect flow, which reactivates the
  // existing row. The hub already dispatches connect from `?connect=<provider>`
  // (the Cmd-K deep-link convention), so the banner reuses that exact path —
  // inherited rows stay read-only in a child workspace.
  const reauth = connection.inherited ? null : reauthAffordance(connection);

  const revoke = async () => {
    const r = await wrap(() => client.integrations.revoke(orgId, connection.id));
    if (!r.ok) {
      // Referential guard (Feature 2): brokered secrets still bind here, or the
      // reference check could not run. Both are fixable — surface the blocked
      // dialog with the force path rather than a dead-end toast.
      const blockers = parseRevokeBlockers(r.error);
      const unavailable = isReferenceCheckUnavailable(r.error);
      if (blockers !== null || unavailable) {
        setRevokeOpen(false);
        setBlocked({ blockers: blockers ?? [], unavailable });
        return;
      }
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Connection revoked" });
    router.push(hubHref);
  };

  // Force-revoke: proceed despite the blockers, orphaning the brokered secrets.
  const forceRevoke = async () => {
    setForcing(true);
    const r = await wrap(() => client.integrations.revoke(orgId, connection.id, { force: true }));
    setForcing(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    const orphanedCount = r.data.orphaned?.length ?? 0;
    setBlocked(null);
    toast({
      kind: "success",
      title: "Connection revoked",
      ...(orphanedCount > 0
        ? { description: `${orphanedCount} brokered secret${orphanedCount === 1 ? "" : "s"} orphaned — repoint or revoke them.` }
        : {}),
    });
    router.push(hubHref);
  };

  return (
    <Screen>
      <QuietLink href={hubHref}>← Integrations</QuietLink>

      {/* Header — provider tile, name, status, scope/sharing provenance. */}
      <div className="mt-4 rounded-xl border bg-card px-5 py-[18px] sm:px-6 sm:py-[22px]">
        <div className="flex flex-wrap items-center gap-3.5">
          <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-[#171717]" aria-hidden>
            <Icon className="h-5 w-5 text-[#FAFAFA]" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold leading-tight">{connectionDisplayName(connection)}</span>
              <Pill tone={STATUS_TONE[statusMeta.tone] ?? "neutral"} dot live={connection.status === "pending"}>
                {connection.status === "active" ? "Connected" : statusMeta.label}
              </Pill>
              <MiniPill>{providerName}</MiniPill>
              <MiniPill>{scopeMeta.label}</MiniPill>
              {shareMeta ? <MiniPill>{shareMeta.label}</MiniPill> : null}
              {connection.inherited ? <MiniPill>Inherited</MiniPill> : null}
            </div>
            <div className="mt-[3px] text-[12.5px] text-muted-foreground">
              {connection.externalAccountLogin ? (
                <>
                  {archetype === "messaging" ? "Workspace" : archetype === "infrastructure" ? "Account" : "Installation"}{" "}
                  <span className="font-mono text-[11.5px]">{connection.externalAccountLogin}</span>
                  {connection.externalAccountType ? <> · {connection.externalAccountType}</> : null}
                  {" · "}
                </>
              ) : null}
              created {new Date(connection.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
              {connection.connectedAt ? (
                <>
                  {" · "}connected{" "}
                  {new Date(connection.connectedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                </>
              ) : null}
              {connection.inherited && connection.sharedByName ? (
                <>
                  {" · "}shared by {connection.sharedByName}
                  {connection.sharedByWorkspaceRef ? ` (${connection.sharedByWorkspaceRef})` : ""}
                </>
              ) : null}
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{shareMeta?.description ?? scopeMeta.description}</p>
      </div>

      {/* IH9: prominent re-auth banner above the facts sections. */}
      {reauth ? (
        <AttentionBanner
          tone="warning"
          className="mt-4"
          action={
            <Button asChild size="sm" className="shrink-0">
              <a href={`${hubHref}?connect=${connection.provider}`}>{reauth.label}</a>
            </Button>
          }
        >
          <span className="font-medium">Connection suspended.</span> {reauth.description}
        </AttentionBanner>
      ) : null}

      {/* Archetype body */}
      {archetype === "messaging" ? (
        <>
          <Kicker className="mb-2.5 mt-8">Channels in use</Kicker>
          <SlackChannels orgId={orgId} connectionId={connection.id} enabled={isActive} />
        </>
      ) : null}

      {archetype === "infrastructure" && custody.length > 0 ? (
        <>
          <Kicker className="mb-2.5 mt-8">Credential custody</Kicker>
          <CustodySummary custody={custody} />
        </>
      ) : null}

      {archetype === "infrastructure" ? (
        <>
          <div className="mb-2.5 mt-8 flex flex-wrap items-end justify-between gap-3">
            <Kicker className="mb-0">Scoped credentials</Kicker>
            {isActive ? (
              <Button asChild size="sm" className="shrink-0">
                {/* SP2 (SP-A4): creation lives in the provider's own space now. */}
                <a href={providerSpaceCreateHref(orgSlug, connection.provider, connection.id)}>
                  Create scoped credential
                </a>
              </Button>
            ) : null}
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border bg-card px-5 py-4">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
            <p className="text-xs text-muted-foreground">
              A scoped credential is a secret bound to this connection at a workspace, project, or environment
              scope. It has no stored value — every <span className="font-mono text-[11px]">orun</span> run
              resolves a fresh, scoped, short-lived credential from it. Create one here or from the{" "}
              <QuietLink href={`/orgs/${orgSlug}/secrets`}>Secrets</QuietLink> page; manage and rotate them
              on Secrets.
            </p>
          </div>

          {templates.length === 0 ? (
            <div className="mt-3 rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
              {capabilitiesQuery.loading
                ? "Loading credential types…"
                : capabilitiesQuery.error
                  ? "Credential types are unavailable right now — try again shortly."
                  : "No scope templates are published for this provider yet."}
            </div>
          ) : (
            <>
              <p className="mb-2.5 mt-6 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                Credential types this connection provides
              </p>
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead>
                      <tr className="border-b text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80">
                        <th className="px-4 py-2.5">Type</th>
                        <th className="px-4 py-2.5">Grants</th>
                        <th className="px-4 py-2.5">Params</th>
                        <th className="px-4 py-2.5">Max TTL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {templates.map((t) => (
                        <tr key={t.id} className="border-t border-border/50 first:border-t-0 align-top">
                          <td className="px-4 py-2.5">
                            <span className="block text-[12.5px] font-semibold">{t.displayName}</span>
                            <span className="block font-mono text-[11px] text-muted-foreground">{t.id}</span>
                          </td>
                          <td className="px-4 py-2.5 text-xs text-muted-foreground">{t.description}</td>
                          <td className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                            {t.params.length > 0 ? t.params.join(", ") : "—"}
                          </td>
                          <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                            {formatTtl(t.maxTtlSeconds)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      ) : null}

      {archetype === "source-control" ? (
        <>
          <Kicker className="mb-2.5 mt-8">Repositories</Kicker>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4">
            <p className="text-xs text-muted-foreground">
              Repository linking lives on each project's Git tab — pick a project to link repositories and map
              branches to environments.
            </p>
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <a href={`/orgs/${orgSlug}/projects`}>Open projects</a>
            </Button>
          </div>
        </>
      ) : null}

      {showAdmission ? (
        <>
          <Kicker className="mb-2.5 mt-8">Workspace access</Kicker>
          <ConnectionAdmission orgId={orgId} connection={connection} onChanged={() => conn.reload()} />
        </>
      ) : null}

      {/* Danger zone — inherited rows are read-only in a child workspace. */}
      {connection.status !== "revoked" && !connection.inherited ? (
        <>
          <Kicker className="mb-2.5 mt-8">Danger zone</Kicker>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-card px-5 py-4">
            <p className="max-w-[640px] text-xs text-muted-foreground">{uninstallDisclosure(connection)}</p>
            <Button variant="destructive" size="sm" className="shrink-0" onClick={() => setRevokeOpen(true)}>
              Revoke connection
            </Button>
          </div>
          <ConfirmDialog
            open={revokeOpen}
            onOpenChange={setRevokeOpen}
            title={`Revoke ${providerName} connection?`}
            description={uninstallDisclosure(connection)}
            resourceName={connectionDisplayName(connection)}
            confirmLabel="Revoke connection"
            onConfirm={revoke}
          />

          {/* Referential guard (Feature 2): brokered secrets still bind here. */}
          <Dialog open={blocked !== null} onOpenChange={(o) => !o && setBlocked(null)}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Can&apos;t revoke — secrets still depend on this connection</DialogTitle>
                <DialogDescription>
                  {blocked?.unavailable
                    ? "The platform couldn't confirm which brokered secrets depend on this connection, so the revoke was refused. You can force it, but any brokered secret bound here will be orphaned and fail to resolve."
                    : "These brokered secrets mint their value from this connection. Revoking it now would orphan them — they'd fail to resolve at plan and run time. Repoint or revoke them first, or force the revoke to orphan them."}
                </DialogDescription>
              </DialogHeader>

              {blocked && blocked.blockers.length > 0 ? (
                <ul className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border bg-muted/40 p-3">
                  {blocked.blockers.map((b) => (
                    <li key={b.id} className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate font-mono">{b.secretKey}</span>
                      {b.scope ? <span className="shrink-0 text-muted-foreground">{b.scope}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              <DialogFooter>
                <Button variant="ghost" onClick={() => setBlocked(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" loading={forcing} onClick={() => void forceRevoke()}>
                  {blocked && blocked.blockers.length > 0
                    ? `Force revoke — orphan ${blocked.blockers.length} secret${blocked.blockers.length === 1 ? "" : "s"}`
                    : "Force revoke anyway"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      ) : null}
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Slack: channels the bot can post to (MessagingCapability listChannels)
// ---------------------------------------------------------------------------

function SlackChannels({
  orgId,
  connectionId,
  enabled,
}: {
  orgId: string;
  connectionId: string;
  enabled: boolean;
}) {
  const { client } = useSession();
  const channels = useApiQuery(
    qk.slackChannels(orgId, connectionId),
    () => wrap(() => client.integrations.listSlackChannels(orgId, connectionId, {})),
    { enabled },
  );

  if (!enabled) {
    return (
      <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
        Channels are listed once the connection is active.
      </div>
    );
  }
  if (channels.loading) return <Skeleton className="h-[92px] w-full rounded-xl" />;
  if (channels.error) {
    return (
      <div className="rounded-xl border bg-card px-5 py-4">
        <div className="text-xs font-medium text-destructive">Could not list channels</div>
        <div className="mt-1 text-xs text-muted-foreground">{channels.error.message}</div>
      </div>
    );
  }
  const list = channels.data?.channels ?? [];
  if (list.length === 0) {
    return (
      <div className="rounded-xl border bg-card px-5 py-4 text-xs text-muted-foreground">
        The bot can't see any channels yet. Invite it to a channel in Slack, or create a Slack notification
        channel under Settings → Notifications.
      </div>
    );
  }
  return (
    <div className="rounded-xl border bg-card px-5 py-4">
      <ul className="flex flex-wrap gap-1.5">
        {list.map((c) => (
          <li
            key={c.id}
            className="inline-flex items-center gap-1 rounded-[10px] border border-border px-2 py-0.5 text-[11.5px] text-secondary-foreground"
          >
            <Hash className="h-3 w-3 text-muted-foreground" strokeWidth={1.8} aria-hidden />
            {c.name}
            {c.isPrivate ? <Lock className="h-3 w-3 text-muted-foreground" strokeWidth={1.8} aria-label="private" /> : null}
          </li>
        ))}
      </ul>
      {channels.data?.nextCursor ? (
        <p className="mt-2 text-[11px] text-muted-foreground">Showing the first page of channels.</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custody summary (service-identity-bootstrap SI6): what the platform holds
// for this connection — org-owned service identities vs deprecated
// user-derived custody — with rotation age. Metadata only; values never
// reach this surface.
// ---------------------------------------------------------------------------

const CUSTODY_KIND_LABELS: Record<string, string> = {
  cloudflare_service_token: "Cloudflare service identity",
  cloudflare_parent_token: "Cloudflare account API token (pasted)",
  cloudflare_refresh_token: "Cloudflare OAuth refresh token",
  supabase_refresh_token: "Supabase management session",
  supabase_project_secret: "Supabase project service keys",
  slack_bot_token: "Slack bot token",
};

function CustodySummary({ custody }: { custody: PublicConnectionCustody[] }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <ul className="divide-y divide-border/50">
        {custody.map((row) => {
          const projectRefs =
            row.kind === "supabase_project_secret" && Array.isArray(row.scopes)
              ? row.scopes.filter((s): s is string => typeof s === "string")
              : null;
          return (
            <li key={row.kind} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[12.5px] font-semibold">
                    {CUSTODY_KIND_LABELS[row.kind] ?? row.kind}
                  </span>
                  {row.userDerived ? (
                    <Pill tone="warning" dot>
                      User-derived — deprecated
                    </Pill>
                  ) : (
                    <Pill tone="success" dot>
                      Organization-owned
                    </Pill>
                  )}
                </div>
                <div className="mt-[3px] text-[11.5px] text-muted-foreground">
                  {row.userDerived
                    ? "Tied to the authorizing person's login. It will be upgraded to a provisioned service identity automatically, or re-connect to upgrade now."
                    : "Provisioned for Orun and owned by the organization — no person's login is involved."}
                  {projectRefs ? ` Keys custodied for ${projectRefs.length} project${projectRefs.length === 1 ? "" : "s"}.` : ""}
                </div>
              </div>
              <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                {row.rotatedAt ? (
                  <>rotated {new Date(row.rotatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</>
                ) : (
                  <>captured {new Date(row.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 10.5px caps outline mini-pill (scope / sharing provenance) — hub twin. */
function MiniPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
      {children}
    </span>
  );
}

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}
