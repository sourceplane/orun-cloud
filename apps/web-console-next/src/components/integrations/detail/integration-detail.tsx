"use client";

// The per-integration detail page (saas-integrations-console IX2). A tabbed page
// whose header + tab set + body are a projection of the served descriptor + the
// resolved connection. IX2 implements the source-control (GitHub) archetype;
// IX3/IX4 add infrastructure + messaging bodies behind the same shell.
//
// Reuses the proven space sub-components: ConnectionAdmission (Workspace access)
// and SpaceActivity (Activity). Overview adds the capability toggles (the IX2
// per-connection `capabilityPrefs`) and the revoke danger zone.

import * as React from "react";
import { useRouter } from "next/navigation";
import { Database, ExternalLink, Filter, GitBranch, Plus } from "lucide-react";
import type { PublicConnection, PublicConnectionCustody } from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  Breadcrumbs,
  Kicker,
  Pill,
  Screen,
  StatCard,
  type Tone,
} from "@/components/ui/northwind";
import { ProviderTile } from "@/components/integrations/provider-tile";
import { Segmented } from "@/components/integrations/segmented";
import { ConnectionAdmission } from "@/components/integrations/connection-admission";
import { SpaceActivity } from "@/components/integrations/space-activity";
import {
  connectionProviderName,
  parseRevokeBlockers,
  isReferenceCheckUnavailable,
  uninstallDisclosure,
} from "@/components/integrations/connections";
import { descriptorById } from "@/components/integrations/registry";
import {
  authorizedDate,
  capabilityToggles,
  custodyProjectRefs,
  detailSubtitle,
  detailTabs,
  deriveArchetype,
  externalManageLink,
  sharingBadge,
  toggleState,
  type CapabilityToggle,
} from "@/components/integrations/detail-model";
import {
  connectionSecrets,
  producerCounts,
  secretBadge,
  secretMetaLine,
  type ConnectionSecret,
} from "@/components/integrations/secret-model";

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_TONE: Record<string, Tone> = {
  active: "success",
  pending: "warning",
  suspended: "warning",
  revoked: "error",
};

export function IntegrationDetail({
  orgId,
  orgSlug,
  providerId,
  focusConnectionId,
}: {
  orgId: string;
  orgSlug: string;
  providerId: string;
  focusConnectionId?: string;
}) {
  const { client } = useSession();
  const router = useRouter();

  const list = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );
  const registry = useApiQuery(qk.integrationRegistry(orgId), () =>
    wrap(async () => (await client.integrations.getRegistry(orgId)).registry),
  );

  const connections = list.data ?? [];
  const target = React.useMemo(() => {
    if (focusConnectionId) return connections.find((c) => c.id === focusConnectionId) ?? null;
    const live = connections.filter(
      (c) => c.provider === providerId && c.status !== "revoked",
    );
    return live[0] ?? connections.find((c) => c.provider === providerId) ?? null;
  }, [connections, focusConnectionId, providerId]);

  // The full connection (repositorySelection + capabilityPrefs) + custody.
  const detail = useApiQuery(
    qk.integration(orgId, target?.id ?? ""),
    () => wrap(async () => await client.integrations.get(orgId, target!.id)),
    { enabled: Boolean(target) },
  );
  const connection = detail.data?.connection ?? target;
  const custody = detail.data?.custody ?? [];
  const descriptor = descriptorById(registry.data, providerId);

  if (list.loading || (target && detail.loading && !detail.data)) {
    return (
      <Screen detail>
        <Skeleton className="h-9 w-40 rounded" />
        <Skeleton className="mt-6 h-[86px] w-full rounded-xl" />
        <Skeleton className="mt-6 h-[220px] w-full rounded-xl" />
      </Screen>
    );
  }

  if (!connection) {
    return (
      <Screen detail>
        <Breadcrumbs items={[{ label: "Integrations", href: `/orgs/${orgSlug}/integrations` }, { label: providerId }]} />
        <EmptyState
          icon={GitBranch}
          title="No connection"
          description="This integration is not connected in this workspace yet."
          primaryAction={{ label: "Back to Integrations", href: `/orgs/${orgSlug}/integrations` }}
        />
      </Screen>
    );
  }

  const providerName = connectionProviderName(connection);
  const archetype = descriptor ? deriveArchetype(descriptor) : "generic";
  const external = externalManageLink(connection);
  const statusTone = STATUS_TONE[connection.status] ?? "neutral";
  const statusLabel =
    connection.status === "active"
      ? "Connected"
      : connection.status.charAt(0).toUpperCase() + connection.status.slice(1);

  return (
    <Screen detail>
      <Breadcrumbs
        items={[
          { label: "Integrations", href: `/orgs/${orgSlug}/integrations` },
          { label: providerName },
        ]}
      />

      {/* Header */}
      <div className="flex flex-wrap items-start gap-4">
        <ProviderTile provider={connection.provider} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-serif text-[30px] font-medium leading-none">{providerName}</h1>
            <Pill tone={statusTone} dot live={connection.status === "pending"}>
              {statusLabel}
            </Pill>
            <span className="rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
              {sharingBadge(connection.scope)}
            </span>
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">{detailSubtitle(connection)}</p>
        </div>
        {external ? (
          <a
            href={external.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border bg-card px-3.5 py-2 text-[13px] font-medium transition-colors hover:bg-muted"
          >
            {external.label}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
      </div>

      <DetailTabs
        orgId={orgId}
        orgSlug={orgSlug}
        archetype={archetype}
        connection={connection}
        custody={custody}
        onChanged={() => {
          detail.reload();
          list.reload();
        }}
        onRevoked={() => router.push(`/orgs/${orgSlug}/integrations`)}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Tab bar + body dispatch
// ---------------------------------------------------------------------------

function DetailTabs({
  orgId,
  orgSlug,
  archetype,
  connection,
  custody,
  onChanged,
  onRevoked,
}: {
  orgId: string;
  orgSlug: string;
  archetype: ReturnType<typeof deriveArchetype>;
  connection: PublicConnection;
  custody: readonly PublicConnectionCustody[];
  onChanged: () => void;
  onRevoked: () => void;
}) {
  const tabs = React.useMemo(() => detailTabs(archetype, connection), [archetype, connection]);
  const [active, setActive] = React.useState(tabs[0]?.id ?? "overview");

  return (
    <div className="mt-8">
      <div role="tablist" className="flex items-center gap-6 border-b border-border">
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setActive(t.id)}
              className={cn(
                "-mb-px border-b-2 pb-3 pt-1 text-[14px] transition-colors",
                on
                  ? "border-link font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="mt-7">
        {active === "overview" ? (
          archetype === "infrastructure" ? (
            <InfraOverviewTab orgId={orgId} connection={connection} custody={custody} onChanged={onChanged} onRevoked={onRevoked} />
          ) : (
            <OverviewTab orgId={orgId} orgSlug={orgSlug} connection={connection} onChanged={onChanged} onRevoked={onRevoked} />
          )
        ) : active === "repositories" ? (
          <RepositoriesTab orgId={orgId} connection={connection} />
        ) : active === "secrets" ? (
          <SecretsTab orgId={orgId} orgSlug={orgSlug} connection={connection} />
        ) : active === "projects" ? (
          <ProjectsTab custody={custody} />
        ) : active === "workspace-access" ? (
          <ConnectionAdmission orgId={orgId} connection={connection} onChanged={onChanged} />
        ) : active === "activity" ? (
          <SpaceActivity orgId={orgId} connections={[connection]} showMints showDeliveries />
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview — stat cards + capability toggles + danger zone
// ---------------------------------------------------------------------------

function OverviewTab({
  orgId,
  orgSlug,
  connection,
  onChanged,
  onRevoked,
}: {
  orgId: string;
  orgSlug: string;
  connection: PublicConnection;
  onChanged: () => void;
  onRevoked: () => void;
}) {
  const days =
    connection.connectedAt != null
      ? Math.max(0, Math.floor((Date.now() - new Date(connection.connectedAt).getTime()) / DAY_MS))
      : null;
  const toggles = capabilityToggles(connection.provider);

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {connection.repositorySelection ? (
          <StatCard
            label="Repositories"
            value={connection.repositorySelection === "all" ? "All" : "Selected"}
            unit="allowed"
            footer={
              <span className="text-muted-foreground">
                {connection.repositorySelection === "all"
                  ? "The installation covers every repository."
                  : "Scoped to an allowlist — Orun only sees what you grant."}
              </span>
            }
          />
        ) : null}
        <StatCard
          label="Sharing"
          value={connection.scope === "account" ? "Account" : "Workspace"}
          unit="scope"
          footer={
            <span className="text-muted-foreground">
              {connection.scope === "account"
                ? "All workspaces under the account may use it."
                : "Private to this workspace."}
            </span>
          }
        />
        {days != null ? (
          <StatCard
            label="Connected"
            value={days === 0 ? "Today" : `${days}d`}
            unit={days === 0 ? undefined : "ago"}
            footer={
              <span className="text-muted-foreground">since {authorizedDate(connection.connectedAt)}</span>
            }
          />
        ) : null}
      </div>

      {toggles.length > 0 && !connection.inherited ? (
        <CapabilityToggles orgId={orgId} connection={connection} toggles={toggles} onChanged={onChanged} />
      ) : null}

      {!connection.inherited ? (
        <DangerZone orgId={orgId} orgSlug={orgSlug} connection={connection} onRevoked={onRevoked} />
      ) : null}
    </div>
  );
}

function CapabilityToggles({
  orgId,
  connection,
  toggles,
  onChanged,
}: {
  orgId: string;
  connection: PublicConnection;
  toggles: readonly CapabilityToggle[];
  onChanged: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  // Optimistic local view seeded from the effective prefs.
  const [prefs, setPrefs] = React.useState<Record<string, boolean>>(() => {
    const seed: Record<string, boolean> = {};
    for (const t of toggles) seed[t.id] = toggleState(t, connection.capabilityPrefs);
    return seed;
  });
  React.useEffect(() => {
    const next: Record<string, boolean> = {};
    for (const t of toggles) next[t.id] = toggleState(t, connection.capabilityPrefs);
    setPrefs(next);
  }, [connection.capabilityPrefs, toggles]);
  const [busy, setBusy] = React.useState<string | null>(null);

  const set = async (toggle: CapabilityToggle, next: boolean) => {
    setBusy(toggle.id);
    setPrefs((p) => ({ ...p, [toggle.id]: next }));
    const r = await wrap(() =>
      client.integrations.update(orgId, connection.id, { capabilityPrefs: { [toggle.id]: next } }),
    );
    setBusy(null);
    if (!r.ok) {
      setPrefs((p) => ({ ...p, [toggle.id]: !next })); // revert
      toast({ kind: "error", title: "Could not update capability", description: r.error.message });
      return;
    }
    onChanged();
  };

  return (
    <section>
      <Kicker className="mb-3">Capabilities</Kicker>
      <div className="overflow-hidden rounded-xl border bg-card">
        {toggles.map((t, i) => (
          <div
            key={t.id}
            className={cn(
              "flex items-center gap-4 px-5 py-4",
              i > 0 && "border-t border-border/60",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">{t.label}</div>
              <div className="mt-0.5 text-[12.5px] text-muted-foreground">{t.description}</div>
            </div>
            <Switch
              checked={prefs[t.id] ?? t.defaultOn}
              onCheckedChange={(v) => void set(t, v)}
              disabled={busy === t.id}
              aria-label={t.label}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function DangerZone({
  orgId,
  orgSlug,
  connection,
  onRevoked,
}: {
  orgId: string;
  orgSlug: string;
  connection: PublicConnection;
  onRevoked: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [confirm, setConfirm] = React.useState(false);
  const providerName = connectionProviderName(connection);

  const revoke = async () => {
    const r = await wrap(() => client.integrations.revoke(orgId, connection.id));
    if (!r.ok) {
      const blockers = parseRevokeBlockers(r.error);
      if (blockers !== null || isReferenceCheckUnavailable(r.error)) {
        // Force past brokered-secret references (they become orphaned).
        const forced = await wrap(() => client.integrations.revoke(orgId, connection.id, { force: true }));
        if (!forced.ok) {
          toast({ kind: "error", title: "Revoke failed", description: forced.error.message });
          return;
        }
      } else {
        toast({ kind: "error", title: "Revoke failed", description: r.error.message });
        return;
      }
    }
    toast({ kind: "success", title: `${providerName} connection revoked` });
    onRevoked();
  };

  return (
    <section className="rounded-xl border border-destructive/30 bg-destructive/[0.03] px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold text-destructive">Revoke this connection</div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
            {uninstallDisclosure(connection)}
          </p>
        </div>
        <Button variant="outline" className="shrink-0" onClick={() => setConfirm(true)}>
          Revoke
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Revoke ${providerName} connection?`}
        description={uninstallDisclosure(connection)}
        confirmLabel="Revoke connection"
        destructive
        onConfirm={revoke}
      />
      {/* orgSlug kept for symmetry with sibling tabs that deep-link. */}
      <span className="hidden" aria-hidden data-org-slug={orgSlug} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Repositories tab (source-control)
// ---------------------------------------------------------------------------

function RepositoriesTab({ orgId, connection }: { orgId: string; connection: PublicConnection }) {
  const { client } = useSession();
  const [view, setView] = React.useState<"all" | "selected">(
    connection.repositorySelection === "selected" ? "selected" : "all",
  );
  const [filter, setFilter] = React.useState("");

  const repos = useApiQuery(qk.integrationRepositories(orgId, connection.id), () =>
    wrap(async () => (await client.integrations.listRepositories(orgId, connection.id)).repositories),
  );
  const all = repos.data ?? [];
  const shown = all.filter((r) => r.fullName.toLowerCase().includes(filter.trim().toLowerCase()));
  const github = externalManageLink(connection);

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold">Repository access</div>
          <p className="mt-1 text-[13px] text-muted-foreground">Choose which repositories plans may act on.</p>
        </div>
        <Segmented
          value={view}
          onChange={setView}
          aria-label="Repository access mode"
          options={[
            { value: "all", label: "All repositories" },
            { value: "selected", label: "Selected only" },
          ]}
        />
      </div>

      {view === "all" ? (
        <div className="mt-5 rounded-xl border border-dashed px-6 py-5">
          <div className="flex items-start gap-3">
            <GitBranch className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
            <div>
              <div className="text-[13.5px] font-medium">
                {repos.loading
                  ? "Loading repositories…"
                  : `All ${all.length} repositories are accessible`}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">
                New repositories are included automatically.{" "}
                {github ? (
                  <a href={github.url} target="_blank" rel="noreferrer noopener" className="font-medium text-foreground underline">
                    Scope access down on GitHub
                  </a>
                ) : (
                  "Scope access down on GitHub"
                )}
                .
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
            <Filter className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter repositories…"
              aria-label="Filter repositories"
              className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            />
            <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
              {all.length} accessible
            </span>
          </div>
          {repos.loading ? (
            <div className="px-5 py-6">
              <Skeleton className="h-5 w-full rounded" />
            </div>
          ) : shown.length === 0 ? (
            <div className="px-5 py-6 text-[13px] text-muted-foreground">
              {all.length === 0 ? "The installation can see no repositories yet." : "No repositories match."}
            </div>
          ) : (
            shown.map((r) => (
              <div key={r.externalId} className="flex items-center gap-3 border-t border-border/50 px-5 py-3 first:border-t-0">
                <span className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] bg-primary text-primary-foreground">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </span>
                <span className="truncate font-mono text-[12.5px]">{r.fullName}</span>
                {r.private ? <Pill tone="neutral">private</Pill> : null}
                {r.defaultBranch ? (
                  <span className="ml-auto shrink-0 text-[11.5px] text-muted-foreground">{r.defaultBranch}</span>
                ) : null}
              </div>
            ))
          )}
          <div className="border-t border-border/60 px-5 py-3 text-[12px] text-muted-foreground">
            The installation&apos;s repository set is managed on GitHub.{" "}
            {github ? (
              <a href={github.url} target="_blank" rel="noreferrer noopener" className="font-medium text-foreground underline">
                Change it on GitHub
              </a>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Infrastructure archetype (Supabase / Cloudflare) — Overview · Secrets · Projects
// ---------------------------------------------------------------------------

function InfraOverviewTab({
  orgId,
  connection,
  custody,
  onChanged,
  onRevoked,
}: {
  orgId: string;
  connection: PublicConnection;
  custody: readonly PublicConnectionCustody[];
  onChanged: () => void;
  onRevoked: () => void;
}) {
  const { client } = useSession();
  const secrets = useApiQuery(qk.configSecrets(`org:${orgId}:all`), () =>
    wrap(async () => (await client.config.listSecretMetadata({ kind: "organization", orgId })).secrets),
  );
  const caps = useApiQuery(qk.secretsCapabilities(orgId), () =>
    wrap(async () => (await client.integrations.listSecretsCapabilities(orgId)).capabilities),
  );

  const produced = connectionSecrets(secrets.data, connection.id);
  const counts = producerCounts(produced);
  const projects = custodyProjectRefs(custody);
  const capability = (caps.data ?? []).find((c) => c.provider === connection.provider);
  const templates = capability?.scopeTemplates ?? [];
  const days =
    connection.connectedAt != null
      ? Math.max(0, Math.floor((Date.now() - new Date(connection.connectedAt).getTime()) / DAY_MS))
      : null;

  return (
    <div className="space-y-8">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Projects"
          value={projects.length}
          unit="linked"
          footer={<span className="text-muted-foreground">Resources this connection custodies.</span>}
        />
        <StatCard
          label="Managed secrets"
          value={counts.total}
          unit={counts.total === 1 ? "secret" : "secrets"}
          footer={
            <span className="text-muted-foreground">
              Minted from this connection{counts.rotated > 0 ? ` · ${counts.brokered} brokered · ${counts.rotated} rotated` : ""}.
            </span>
          }
        />
        {days != null ? (
          <StatCard
            label="Connected"
            value={days === 0 ? "Today" : `${days}d`}
            unit={days === 0 ? undefined : "ago"}
            footer={<span className="text-muted-foreground">since {authorizedDate(connection.connectedAt)}</span>}
          />
        ) : null}
      </div>

      {templates.length > 0 ? (
        <section>
          <Kicker className="mb-3">What Orun can broker</Kicker>
          <div className="overflow-hidden rounded-xl border bg-card">
            {templates.map((t, i) => (
              <div key={t.id} className={cn("px-5 py-4", i > 0 && "border-t border-border/60")}>
                <div className="text-[14px] font-medium">{t.displayName}</div>
                <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">{t.description}</div>
              </div>
            ))}
          </div>
        </section>
      ) : caps.loading ? (
        <Skeleton className="h-[140px] w-full rounded-xl" />
      ) : null}

      {!connection.inherited ? (
        <DangerZone orgId={orgId} orgSlug="" connection={connection} onRevoked={onRevoked} />
      ) : null}
      {/* onChanged reserved for future in-place edits on this tab. */}
      <span className="hidden" aria-hidden data-changed={String(Boolean(onChanged))} />
    </div>
  );
}

function SecretsTab({
  orgId,
  orgSlug,
  connection,
}: {
  orgId: string;
  orgSlug: string;
  connection: PublicConnection;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const [rotating, setRotating] = React.useState<string | null>(null);

  const secrets = useApiQuery(qk.configSecrets(`org:${orgId}:all`), () =>
    wrap(async () => (await client.config.listSecretMetadata({ kind: "organization", orgId })).secrets),
  );
  const produced = connectionSecrets(secrets.data, connection.id);
  const providerName = connectionProviderName(connection);

  const rotate = async (item: ConnectionSecret) => {
    setRotating(item.secret.id);
    const r = await wrap(() =>
      client.config.rotateScopedCredential({ kind: "organization", orgId }, item.secret.id, {}),
    );
    setRotating(null);
    if (!r.ok) {
      toast({ kind: "error", title: "Rotate failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: `${item.secret.secretKey} rotated` });
    secrets.reload();
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-semibold">Secrets brokered from {providerName}</div>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Orun mints these from the connection — most never touch disk.
          </p>
        </div>
        <Button onClick={() => router.push(`/orgs/${orgSlug}/integrations/${connection.provider}?create=1`)}>
          <Plus className="h-4 w-4" aria-hidden />
          New secret
        </Button>
      </div>

      {secrets.loading ? (
        <Skeleton className="mt-5 h-[160px] w-full rounded-xl" />
      ) : produced.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed px-6 py-8 text-center">
          <div className="text-[13.5px] font-medium">No secrets brokered yet</div>
          <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
            Create a secret and Orun will mint it from this connection per run — no long-lived credential is stored.
          </p>
        </div>
      ) : (
        <div className="mt-5 overflow-hidden rounded-xl border bg-card">
          {produced.map((item, i) => {
            const badge = secretBadge(item);
            return (
              <div key={item.secret.id} className={cn("flex flex-wrap items-center gap-3 px-5 py-4", i > 0 && "border-t border-border/60")}>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[13px] font-semibold">{item.secret.secretKey}</div>
                  <div className="mt-1 text-[12px] text-muted-foreground">
                    {secretMetaLine(item)}
                    {item.secret.scopeKind ? <> · {item.secret.scopeKind}</> : null}
                    {item.mode === "rotated" ? <> · stored encrypted</> : <> · ≤ 1h</>}
                  </div>
                </div>
                <Pill tone={badge.tone} dot>
                  {badge.label}
                </Pill>
                {item.mode === "rotated" ? (
                  <Button variant="outline" size="sm" disabled={rotating === item.secret.id} onClick={() => void rotate(item)}>
                    {rotating === item.secret.id ? "Rotating…" : "Rotate now"}
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => router.push(`/orgs/${orgSlug}/settings/secrets`)}>
                    Manage
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProjectsTab({ custody }: { custody: readonly PublicConnectionCustody[] }) {
  const projects = custodyProjectRefs(custody);
  if (projects.length === 0) {
    return (
      <div className="rounded-xl border border-dashed px-6 py-8 text-center text-[13px] text-muted-foreground">
        No linked projects on record for this connection yet.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      {projects.map((p, i) => (
        <div key={`${p.ref}-${i}`} className={cn("flex items-center gap-3 px-5 py-3.5", i > 0 && "border-t border-border/50")}>
          <Database className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
          <span className="truncate font-mono text-[12.5px]">{p.ref}</span>
          <Pill tone="success" dot className="ml-auto">
            Active
          </Pill>
        </div>
      ))}
    </div>
  );
}
