"use client";

// The Integrations hub — a first-class org surface: ONE directory of every
// integration the platform coordinates, rendered from the served Integration
// Registry (saas-integration-registry IR1). Sections are category-grouped
// (Source control · Messaging · Infrastructure · AI & compute · Roadmap) and
// every card is a pure function of its `IntegrationDescriptor` + this org's
// connections — the hub holds NO provider catalog and NO per-provider
// branches (the old `providers.ts` + `id === "cloudflare"` special case are
// gone; connect posture comes from `descriptor.connect`).
//
// Connect dispatch (registry.ts `connectDispatch`):
// - a single live install/oauth method → popup + poll here (the worker
//   returns a URL carrying the signed single-use state; our ingress
//   activates; the poll loop observes).
// - anything else (token method, multiple methods) → the provider's space
//   owns the flow (`/integrations/providers/{id}?connect=1`).
//
// SP-A5: while the registry read is loading/failed, connect entry points
// render disabled with a hint — never a baked-in fallback catalog.

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  GitBranch,
  Plug,
  Database,
  Cloud,
  Cpu,
  MessageSquare,
  MessageCircle,
  Server,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type {
  IntegrationDescriptor,
  PublicConnection,
} from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  Kicker,
  PageHeader,
  Pill,
  Screen,
  type Tone,
} from "@/components/ui/northwind";
import {
  connectionDisplayName,
  connectionProviderName,
  connectionScopeMeta,
  connectionShareModeMeta,
  connectionStatusMeta,
  hasPendingConnection,
  reauthAffordance,
  uninstallDisclosure,
  visibleConnections,
} from "@/components/integrations/connections";
import {
  cardState,
  connectDispatch,
  descriptorById,
  groupByCategory,
  providerIconName,
} from "@/components/integrations/registry";
import { ProviderConnections } from "@/components/agents/provider-connections";
import { ConnectionAdmission } from "@/components/integrations/connection-admission";

const POLL_INTERVAL_MS = 2500;
const POLL_BUDGET_MS = 11 * 60 * 1000; // connect state TTL (10 min) + margin
const REGISTRY_STALE_MS = 10 * 60_000; // manifests are static per deploy

/** lucide resolution for registry icon names (registry.ts picks the name). */
const ICONS: Record<string, LucideIcon> = {
  Github: GitBranch, // connect slots only; the live GitHub card uses the solid mark
  GitBranch,
  Database,
  Cloud,
  Cpu,
  MessageSquare,
  MessageCircle,
  Server,
  Sparkles,
  Plug,
};

/** Badge tone (connections.ts) → Northwind pill tone. */
const STATUS_TONE: Record<string, Tone> = {
  default: "neutral",
  success: "success",
  warning: "warning",
  destructive: "error",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function IntegrationsHub({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const list = useApiQuery(qk.integrations(orgId), () =>
    wrap(async () => (await client.integrations.list(orgId)).connections),
  );
  const registryQuery = useApiQuery(
    qk.integrationRegistry(orgId),
    () => wrap(async () => (await client.integrations.getRegistry(orgId)).registry),
    { staleTime: REGISTRY_STALE_MS },
  );
  const registry = React.useMemo(() => registryQuery.data ?? [], [registryQuery.data]);

  const [connectingProvider, setConnectingProvider] = React.useState<string | null>(null);
  const [gateError, setGateError] = React.useState<ApiErrorBody | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<PublicConnection | null>(null);
  const pollUntil = React.useRef<number>(0);

  const connections = list.data ?? [];
  const visible = visibleConnections(connections);
  const connectingActive =
    connectingProvider !== null &&
    connections.some((c) => c.provider === connectingProvider && c.status === "active");

  // While a connect popup is in flight (or a pending row exists), poll the list
  // so the row flips to Active without a manual refresh.
  const shouldPoll =
    (connectingProvider !== null || hasPendingConnection(connections)) &&
    Date.now() < pollUntil.current;
  React.useEffect(() => {
    if (!shouldPoll) return;
    const t = setInterval(() => list.reload(), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [shouldPoll, list]);

  React.useEffect(() => {
    if (connectingActive && connectingProvider) {
      toast({
        kind: "success",
        title: `${descriptorById(registry, connectingProvider)?.displayName ?? connectingProvider} connected`,
      });
      setConnectingProvider(null);
    }
  }, [connectingActive, connectingProvider, registry, toast]);

  // Dispatch is descriptor-driven (registry.ts): popup kinds run the shared
  // popup + poll machinery through the provider-generic SDK connect; every
  // other posture navigates to the provider's space, which owns the flow.
  const connect = React.useCallback(
    async (descriptor: IntegrationDescriptor) => {
      setGateError(null);
      const dispatch = connectDispatch(descriptor);
      if (dispatch.kind === "none") return;
      if (dispatch.kind === "space") {
        router.push(`/orgs/${orgSlug}/integrations/providers/${descriptor.id}?connect=1`);
        return;
      }
      const r = await wrap(() => client.integrations.connect(orgId, descriptor.id));
      if (!r.ok) {
        if (r.status === 412) {
          setGateError(r.error);
        } else {
          toast({ kind: "error", title: "Could not start the connection", description: r.error.message });
        }
        return;
      }
      pollUntil.current = Date.now() + POLL_BUDGET_MS;
      setConnectingProvider(descriptor.id);
      list.reload();
      const { installUrl } = r.data;
      const popup = window.open(installUrl, `${descriptor.id}-connect`, "width=1020,height=780");
      if (!popup && installUrl) {
        // Popup blocked — same flow, same tab.
        window.location.assign(installUrl);
      }
    },
    [client, orgId, orgSlug, router, list, toast],
  );

  // Cmd-K deep link: `?connect=<provider>` triggers the same registry-driven
  // dispatch once both reads are in (so the available/unconnected check is
  // real), then clears the param — mirroring the app's `?new=1` convention.
  const consumedConnectParam = React.useRef(false);
  React.useEffect(() => {
    if (consumedConnectParam.current) return;
    const requested = searchParams?.get("connect");
    if (!requested || !list.data || !registryQuery.data) return;
    consumedConnectParam.current = true;
    const descriptor = descriptorById(registryQuery.data, requested);
    if (descriptor && cardState(descriptor, list.data) === "available") {
      void connect(descriptor);
    }
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("connect");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, list.data, registryQuery.data, connect, pathname, router]);

  const revoke = async (connection: PublicConnection) => {
    const r = await wrap(() => client.integrations.revoke(orgId, connection.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Connection revoked" });
    list.reload();
  };

  // Registry-derived sections: unconnected live providers by category
  // ("connected" cards render above, in the Connected section), plus the
  // roadmap strip. AI & compute keeps its section chrome with the embedded
  // agents panel until IR5 re-homes those connections into the registry.
  const unconnectedGroups = groupByCategory(
    registry.filter((d) => {
      const state = cardState(d, connections);
      return state === "available" || state === "locked" || state === "configure";
    }),
  );
  const roadmap = registry.filter((d) => cardState(d, connections) === "roadmap");

  const githubDescriptor = descriptorById(registry, "github");
  const githubConnected = connections.some(
    (c) => c.provider === "github" && c.status === "active",
  );

  return (
    <Screen>
      <PageHeader
        title="Integrations"
        description="Orun is an orchestration plane over the services you already use. Connect a provider, and plans can act on it — without storing your credentials."
        actions={
          githubDescriptor && cardState(githubDescriptor, connections) !== "roadmap" ? (
            <Button
              onClick={() => void connect(githubDescriptor)}
              disabled={connectingProvider !== null || registryQuery.loading}
            >
              {connectingProvider === "github"
                ? "Waiting for GitHub…"
                : githubConnected
                  ? "Connect another"
                  : "Connect GitHub"}
            </Button>
          ) : undefined
        }
      />

      {gateError ? (
        <div className="mt-6">
          <PreconditionInsight
            error={gateError}
            resource="integration"
            onUpgrade={() => router.push(`/orgs/${orgSlug}/settings/billing`)}
            onDismiss={() => setGateError(null)}
          />
        </div>
      ) : null}

      <Kicker className="mb-2.5 mt-8">Connected</Kicker>
      {list.loading ? (
        <div className="space-y-3">
          <Skeleton className="h-[168px] w-full rounded-xl" />
        </div>
      ) : list.error ? (
        <div className="rounded-xl border bg-card px-6 py-5">
          <div className="text-[13.5px] font-medium text-destructive">Failed to load connections</div>
          <div className="mt-1 text-xs text-muted-foreground">{list.error.message}</div>
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={GitBranch}
          title="No connections yet"
          description="Connect a provider below — GitHub for repositories, Slack for notifications — and plans can act on it."
          {...(githubDescriptor
            ? { primaryAction: { label: "Connect GitHub", onClick: () => void connect(githubDescriptor) } }
            : {})}
        />
      ) : (
        <div className="space-y-3">
          {visible.map((connection) => (
            <ConnectionCard
              key={connection.id}
              orgId={orgId}
              orgSlug={orgSlug}
              connection={connection}
              onRevoke={() => setRevokeTarget(connection)}
              onReconnect={() => {
                const d = descriptorById(registry, connection.provider);
                if (d) void connect(d);
              }}
              reconnectWaiting={connectingProvider === connection.provider}
              reconnectDisabled={connectingProvider !== null || registryQuery.loading}
              onChanged={() => list.reload()}
            />
          ))}
        </div>
      )}

      {/* Registry-driven sections (IR1): every unconnected live provider gets
          a card under its category kicker. SP-A5: loading renders a skeleton
          strip; a failed read renders the honest hint — never a fallback
          catalog. */}
      {registryQuery.loading ? (
        <>
          <Kicker className="mb-2.5 mt-8">Available</Kicker>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-[104px] rounded-xl" />
            <Skeleton className="h-[104px] rounded-xl" />
            <Skeleton className="h-[104px] rounded-xl" />
          </div>
        </>
      ) : registryQuery.error ? (
        <div className="mt-8 rounded-xl border bg-card px-6 py-5">
          <div className="text-[13.5px] font-medium">Integration directory unavailable</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Could not load the integration registry — connected providers keep working; new
            connections are paused until it recovers. {registryQuery.error.message}
          </div>
        </div>
      ) : (
        unconnectedGroups.map((group) => (
          <React.Fragment key={group.category}>
            <Kicker className="mb-2.5 mt-8">{group.label}</Kicker>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((descriptor) => (
                <ProviderCard
                  key={descriptor.id}
                  descriptor={descriptor}
                  state={cardState(descriptor, connections)}
                  waiting={connectingProvider === descriptor.id}
                  disabled={connectingProvider !== null}
                  onConnect={() => void connect(descriptor)}
                  onUpgrade={() => router.push(`/orgs/${orgSlug}/settings/billing`)}
                />
              ))}
            </div>
          </React.Fragment>
        ))
      )}

      {/* BYO agent providers (saas-agents AG12 §10.5). Section chrome is
          registry-ordered (ai-provider · compute close the category walk);
          the embedded panel is the pre-IR5 state — IR5 re-homes these
          connections into `integrations.connections` and this becomes
          registry cards like everything above. */}
      <Kicker className="mb-2.5 mt-8">AI &amp; compute providers</Kicker>
      <ProviderConnections orgId={orgId} />

      {/* Roadmap providers — honest "Soon" slots from `status: "roadmap"`
          manifests; the same source of truth as live cards, so ghost drift
          cannot recur. */}
      {roadmap.length > 0 ? (
        <>
          <Kicker className="mb-2.5 mt-8">On the roadmap</Kicker>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {roadmap.map((descriptor) => {
              const Icon = ICONS[providerIconName(descriptor)] ?? Plug;
              return (
                <div
                  key={descriptor.id}
                  className="rounded-xl border border-dashed bg-muted px-5 py-[18px]"
                >
                  <div className="flex items-center gap-2.5">
                    <Icon className="h-[18px] w-[18px] shrink-0 text-muted-foreground" strokeWidth={1.8} aria-hidden />
                    <span className="text-[13.5px] font-semibold text-secondary-foreground">
                      {descriptor.displayName}
                    </span>
                    <span className="ml-auto shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
                      Soon
                    </span>
                  </div>
                  <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
                    {descriptor.tagline}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={`Revoke ${revokeTarget ? connectionProviderName(revokeTarget) : ""} connection?`}
        description={
          revokeTarget
            ? uninstallDisclosure(revokeTarget)
            : "The platform stops receiving events for this connection and anything linked to it stops updating."
        }
        resourceName={revokeTarget ? connectionDisplayName(revokeTarget) : undefined}
        confirmLabel="Revoke connection"
        onConfirm={async () => {
          if (revokeTarget) await revoke(revokeTarget);
        }}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Unconnected provider card — a pure function of descriptor + card state.
// ---------------------------------------------------------------------------

function ProviderCard({
  descriptor,
  state,
  waiting,
  disabled,
  onConnect,
  onUpgrade,
}: {
  descriptor: IntegrationDescriptor;
  state: ReturnType<typeof cardState>;
  waiting: boolean;
  disabled: boolean;
  onConnect: () => void;
  onUpgrade: () => void;
}) {
  const Icon = ICONS[providerIconName(descriptor)] ?? Plug;
  return (
    <div className="rounded-xl border bg-card px-5 py-[18px]">
      <div className="flex items-center gap-2.5">
        <Icon
          className="h-[18px] w-[18px] shrink-0 text-secondary-foreground"
          strokeWidth={1.8}
          aria-hidden
        />
        <span className="text-[13.5px] font-semibold">{descriptor.displayName}</span>
        {state === "locked" ? (
          <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={onUpgrade}>
            Upgrade
          </Button>
        ) : state === "configure" ? (
          <span className="ml-auto shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
            Not configured
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0"
            disabled={disabled}
            onClick={onConnect}
          >
            {waiting ? `Waiting for ${descriptor.displayName}…` : "Connect"}
          </Button>
        )}
      </div>
      <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {state === "configure"
          ? `${descriptor.tagline} This environment has no ${descriptor.displayName} credentials registered yet — an operator sets them per environment.`
          : descriptor.tagline}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connected provider card
// ---------------------------------------------------------------------------

/** Dark-tile icon per provider; GitHub keeps its solid mark. */
const CONNECTED_TILE_ICONS: Record<string, LucideIcon> = {
  slack: MessageSquare,
  cloudflare: Cloud,
  supabase: Database,
};

/** What the external anchor IS, per provider ("Installation acme · …"). */
function externalAnchorLabel(provider: PublicConnection["provider"]): string {
  switch (provider) {
    case "slack":
      return "Workspace";
    case "cloudflare":
      return "Account";
    case "supabase":
      return "Organization";
    default:
      return "Installation";
  }
}

function ConnectionCard({
  orgId,
  orgSlug,
  connection,
  onRevoke,
  onReconnect,
  reconnectWaiting,
  reconnectDisabled,
  onChanged,
}: {
  orgId: string;
  orgSlug: string;
  connection: PublicConnection;
  onRevoke: () => void;
  onReconnect: () => void;
  reconnectWaiting: boolean;
  reconnectDisabled: boolean;
  onChanged: () => void;
}) {
  const meta = connectionStatusMeta(connection.status);
  const scopeMeta = connectionScopeMeta(connection.scope);
  const shareMeta = connectionShareModeMeta(connection);
  const tone = STATUS_TONE[meta.tone] ?? "neutral";
  const statusLabel = connection.status === "active" ? "Connected" : meta.label;
  const providerName = connectionProviderName(connection);
  const TileIcon = CONNECTED_TILE_ICONS[connection.provider];
  // IH9 re-auth CTA: a suspended oauth/token-kind connection re-runs the
  // provider's connect flow, which reactivates the existing row.
  const reauth = connection.inherited ? null : reauthAffordance(connection);

  const caption = connection.inherited
    ? `Shared by ${connection.sharedByName ?? "your account"}${
        connection.sharedByWorkspaceRef ? ` (${connection.sharedByWorkspaceRef})` : ""
      }${connection.provider === "github" ? " — link repos from a project's Git tab" : ""}`
    : connection.connectedAt
      ? `authorized ${new Date(connection.connectedAt).toLocaleDateString(undefined, {
          month: "short",
          year: "numeric",
        })}`
      : connection.status === "pending"
        ? connection.provider === "github"
          ? "waiting for the GitHub install to finish"
          : `waiting for the ${providerName} authorization to finish`
        : null;

  return (
    <div className="rounded-xl border bg-card px-5 py-[18px] sm:px-6 sm:py-[22px]">
      <div className="flex flex-wrap items-center gap-3.5">
        <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] bg-[#171717]" aria-hidden>
          {TileIcon ? (
            <TileIcon className="h-5 w-5 text-[#FAFAFA]" strokeWidth={1.8} />
          ) : (
            <GithubMark />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/orgs/${orgSlug}/integrations/${connection.id}`}
              className="text-[15px] font-semibold leading-tight hover:underline"
            >
              {providerName}
            </Link>
            <Pill tone={tone} dot live={connection.status === "pending"}>
              {statusLabel}
            </Pill>
            <MiniPill>{scopeMeta.label}</MiniPill>
            {shareMeta ? <MiniPill>{shareMeta.label}</MiniPill> : null}
            {connection.inherited ? <MiniPill>Inherited</MiniPill> : null}
          </div>
          <div className="mt-[3px] text-[12.5px] text-muted-foreground">
            {externalAnchorLabel(connection.provider)}{" "}
            <span className="font-mono text-[11.5px]">{connectionDisplayName(connection)}</span>
            {connection.externalAccountType ? <> · {connection.externalAccountType}</> : null}
            {caption ? <> · {caption}</> : null}
          </div>
        </div>
        {/* Inherited connections are read-only in a child workspace. */}
        {connection.status !== "revoked" && !connection.inherited ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {reauth ? (
              <Button size="sm" disabled={reconnectDisabled} onClick={onReconnect}>
                {reconnectWaiting ? `Waiting for ${providerName}…` : reauth.label}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onRevoke}>
              Revoke
            </Button>
          </div>
        ) : null}
      </div>

      {reauth ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-muted-foreground">{reauth.description}</p>
      ) : null}

      {connection.status === "active" ? (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {connection.repositorySelection ? (
            <StatTile
              label="Repositories"
              value={connection.repositorySelection === "all" ? "All" : "Selected"}
              unit="allowed"
              caption={
                connection.repositorySelection === "all"
                  ? "The installation covers every repository."
                  : "Allowlist — Orun only sees what you grant."
              }
            />
          ) : null}
          <StatTile
            label="Sharing"
            value={connection.scope === "account" ? "Account" : "Workspace"}
            unit="scope"
            caption={shareMeta?.description ?? scopeMeta.description}
          />
          {connection.connectedAt ? (
            <ConnectedTile connectedAt={connection.connectedAt} />
          ) : null}
        </div>
      ) : null}

      {connection.status === "active" && connection.scope === "account" && !connection.inherited ? (
        <ConnectionAdmission orgId={orgId} connection={connection} onChanged={onChanged} />
      ) : null}
    </div>
  );
}

function ConnectedTile({ connectedAt }: { connectedAt: string }) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(connectedAt).getTime()) / DAY_MS));
  return (
    <StatTile
      label="Connected"
      value={days === 0 ? "Today" : `${days}d`}
      unit={days === 0 ? undefined : "ago"}
      caption={`since ${new Date(connectedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`}
    />
  );
}

/** Inner stat tile: kicker + serif 22px value + 13px unit + 12px caption. */
function StatTile({
  label,
  value,
  unit,
  caption,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string | undefined;
  caption: string;
}) {
  return (
    <div className="rounded-[10px] border border-[#ECECEC] px-4 py-3.5 dark:border-border">
      <Kicker className="tracking-[.07em]">{label}</Kicker>
      <div className="mt-1.5 font-serif text-[22px] font-medium leading-tight">
        {value}
        {unit ? <span className="font-sans text-[13px] font-normal text-muted-foreground"> {unit}</span> : null}
      </div>
      <div className="mt-1 text-xs leading-normal text-muted-foreground">{caption}</div>
    </div>
  );
}

/** 10.5px caps outline mini-pill (scope / sharing provenance). */
function MiniPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
      {children}
    </span>
  );
}

/** Solid GitHub mark (the lucide icon is stroke-only; the mock uses the mark). */
function GithubMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="#FAFAFA" aria-hidden>
      <path d="M12 1.27a11 11 0 0 0-3.48 21.46c.55.09.73-.28.73-.55v-1.84c-3.03.64-3.67-1.46-3.67-1.46-.55-1.29-1.28-1.65-1.28-1.65-.92-.65.1-.65.1-.65 1.1 0 1.73 1.1 1.73 1.1.92 1.65 2.57 1.2 3.21.92a2 2 0 0 1 .64-1.47c-2.47-.27-5.04-1.19-5.04-5.5 0-1.1.46-2.1 1.2-2.84a3.76 3.76 0 0 1 0-2.93s.91-.28 3.11 1.1c1.8-.49 3.7-.49 5.5 0 2.1-1.38 3.02-1.1 3.02-1.1a3.76 3.76 0 0 1 .1 2.84 4.1 4.1 0 0 1 1.19 2.93c0 4.31-2.58 5.23-5.04 5.5.45.37.82.92.82 2.02v3.03c0 .27.1.64.73.55A11 11 0 0 0 12 1.27" />
    </svg>
  );
}
