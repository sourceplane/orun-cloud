"use client";

// The Integrations hub (saas-integrations-console IX1) — a directory of every
// integration the platform coordinates, rendered purely from the served
// Integration Registry (IR1) + this org's connections + best-effort brokered
// secret metadata. Structure follows the Orun Integrations Console design:
//   • summary stats (Connected · Brokered secrets · Available)
//   • a status + category filter bar with a search box
//   • Connected as compact rows (Manage → the provider's detail page)
//   • Available as a grid of connect cards; a roadmap strip below
//
// The hub holds NO provider catalog and NO per-provider branches — connect
// posture comes from `descriptor.connect` (registry.ts `connectDispatch`). Rich
// per-connection controls (capabilities, admission, revoke, activity) live on
// the detail page (IX2+); the hub only routes to them.
//
// SP-A5: while the registry read is loading/failed, connect entry points render
// disabled with a hint — never a baked-in fallback catalog. The brokered read
// is a best-effort enrichment; the hub renders without it.

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  Cloud,
  Cpu,
  Database,
  GitBranch,
  MessageCircle,
  MessageSquare,
  Plug,
  Plus,
  Search,
  Server,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type {
  IntegrationCategory,
  IntegrationDescriptor,
  PublicConnection,
} from "@saas/contracts/integrations";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  Chip,
  ChipDivider,
  ChipRow,
  Kicker,
  ListCard,
  PageHeader,
  Pill,
  Screen,
  StatCard,
  type Tone,
} from "@/components/ui/northwind";
import {
  connectionProviderName,
  hasPendingConnection,
  visibleConnections,
} from "@/components/integrations/connections";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  cardState,
  connectDispatch,
  descriptorById,
  groupByCategory,
  providerIconName,
} from "@/components/integrations/registry";
import {
  brokeredByConnection,
  connectedMetaLine,
  hubSummary,
  isLiveConnection,
  matchesSearch,
  matchesStatus,
  presentCategories,
  roadmapListSentence,
  type HubStatusFilter,
} from "@/components/integrations/hub-model";
import { ProviderTile } from "@/components/integrations/provider-tile";

const POLL_INTERVAL_MS = 2500;
const POLL_BUDGET_MS = 11 * 60 * 1000; // connect state TTL (10 min) + margin
const REGISTRY_STALE_MS = 10 * 60_000; // manifests are static per deploy

/** lucide resolution for registry icon names (available-card glyphs). */
const ICONS: Record<string, LucideIcon> = {
  Github: GitBranch,
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
  // Best-effort: brokered secrets bound to this org's connections, for the
  // summary stat + per-row "N brokered secrets" meta. Guarded — the hub renders
  // fully without it (a user may lack secret.read, or none may be brokered).
  const brokeredQuery = useApiQuery(qk.configSecrets(`org:${orgId}:brokered`), () =>
    wrap(async () =>
      (await client.config.listSecretMetadata({ kind: "organization", orgId })).secrets.filter(
        (s) => s.source === "brokered",
      ),
    ),
  );
  const registry = React.useMemo(() => registryQuery.data ?? [], [registryQuery.data]);
  const connections = React.useMemo(() => list.data ?? [], [list.data]);
  const brokered = brokeredQuery.data ?? null;

  const [statusFilter, setStatusFilter] = React.useState<HubStatusFilter>("all");
  const [categoryFilter, setCategoryFilter] = React.useState<IntegrationCategory | null>(null);
  const [query, setQuery] = React.useState("");
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [connectingProvider, setConnectingProvider] = React.useState<string | null>(null);
  const [gateError, setGateError] = React.useState<ApiErrorBody | null>(null);
  const pollUntil = React.useRef<number>(0);

  const connectingActive =
    connectingProvider !== null &&
    connections.some((c) => c.provider === connectingProvider && c.status === "active");

  // While a connect popup is in flight (or a pending row exists), poll the list.
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

  const connect = React.useCallback(
    async (descriptor: IntegrationDescriptor) => {
      setGateError(null);
      const dispatch = connectDispatch(descriptor);
      if (dispatch.kind === "none") return;
      if (dispatch.kind === "space") {
        router.push(`/orgs/${orgSlug}/integrations/${descriptor.id}?connect=1`);
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
      if (!popup && installUrl) window.location.assign(installUrl);
    },
    [client, orgId, orgSlug, router, list, toast],
  );

  // Cmd-K deep link: `?connect=<provider>` triggers dispatch once both reads
  // land, then clears the param.
  const consumedConnectParam = React.useRef(false);
  React.useEffect(() => {
    if (consumedConnectParam.current) return;
    const requested = searchParams?.get("connect");
    if (!requested || !list.data || !registryQuery.data) return;
    consumedConnectParam.current = true;
    const descriptor = descriptorById(registryQuery.data, requested);
    if (descriptor && cardState(descriptor, list.data) === "available") void connect(descriptor);
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete("connect");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, list.data, registryQuery.data, connect, pathname, router]);

  // ── Derivations ──────────────────────────────────────────────────────
  const summary = React.useMemo(
    () => hubSummary(connections, registry, brokered),
    [connections, registry, brokered],
  );
  const brokeredCounts = React.useMemo(() => brokeredByConnection(brokered), [brokered]);
  const categories = React.useMemo(
    () => presentCategories(registry, CATEGORY_ORDER),
    [registry],
  );

  const searchMatch = React.useCallback(
    (d: IntegrationDescriptor) => matchesSearch(d, query, CATEGORY_LABELS[d.category]),
    [query],
  );
  const categoryMatch = React.useCallback(
    (c: IntegrationCategory) => categoryFilter === null || categoryFilter === c,
    [categoryFilter],
  );

  // Connected rows (compact), filtered by status/category/search.
  const connectedRows = React.useMemo(() => {
    if (!matchesStatus("connected", statusFilter)) return [];
    return visibleConnections(connections)
      .filter(isLiveConnection)
      .filter((c) => {
        const d = descriptorById(registry, c.provider);
        if (!categoryMatch(d?.category ?? "source-control")) return false;
        if (d) return searchMatch(d);
        // No descriptor (registry not loaded): match on provider name.
        return query.trim() === "" || connectionProviderName(c).toLowerCase().includes(query.trim().toLowerCase());
      });
  }, [connections, registry, statusFilter, categoryMatch, searchMatch, query]);

  // Available descriptors (grid), filtered.
  const availableDescriptors = React.useMemo(
    () =>
      registry.filter((d) => {
        const state = cardState(d, connections);
        if (!(state === "available" || state === "locked" || state === "configure")) return false;
        return matchesStatus("available", statusFilter) && categoryMatch(d.category) && searchMatch(d);
      }),
    [registry, connections, statusFilter, categoryMatch, searchMatch],
  );

  const roadmapDescriptors = React.useMemo(
    () =>
      statusFilter === "connected"
        ? []
        : registry.filter(
            (d) => cardState(d, connections) === "roadmap" && categoryMatch(d.category) && searchMatch(d),
          ),
    [registry, connections, statusFilter, categoryMatch, searchMatch],
  );

  return (
    <Screen>
      <PageHeader
        title="Integrations"
        description="An orchestration plane over the services you already use. Connect a provider, and plans can act on it — without storing your credentials."
        actions={
          <div className="flex items-center gap-2.5">
            <div className="relative hidden sm:block">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search integrations"
                aria-label="Search integrations"
                className="h-9 w-[230px] pl-9"
              />
            </div>
            <Button onClick={() => setPickerOpen(true)} disabled={registryQuery.loading}>
              <Plus className="h-4 w-4" aria-hidden />
              Connect
            </Button>
          </div>
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

      {/* Summary stats */}
      <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Connected"
          value={summary.connectedCount}
          unit={`across ${summary.categoryCount} categor${summary.categoryCount === 1 ? "y" : "ies"}`}
        />
        <StatCard
          label="Brokered secrets"
          value={summary.brokeredCount}
          unit={
            summary.brokeredCount > 0
              ? `from ${summary.brokeredProviders} provider${summary.brokeredProviders === 1 ? "" : "s"}`
              : "none minted yet"
          }
        />
        <StatCard
          label="Available"
          value={summary.availableCount}
          unit="ready to connect"
        />
      </div>

      {/* Filter bar */}
      <div className="mt-6">
        <ChipRow>
          {(["all", "connected", "available"] as const).map((f) => (
            <Chip key={f} active={statusFilter === f} onClick={() => setStatusFilter(f)}>
              {f === "all" ? "All" : f === "connected" ? "Connected" : "Available"}
            </Chip>
          ))}
          {categories.length > 0 ? <ChipDivider /> : null}
          {categories.map((c) => (
            <Chip
              key={c}
              active={categoryFilter === c}
              onClick={() => setCategoryFilter(categoryFilter === c ? null : c)}
            >
              {CATEGORY_LABELS[c]}
            </Chip>
          ))}
        </ChipRow>
      </div>

      {/* Connected section */}
      {statusFilter !== "available" ? (
        <section className="mt-7">
          <Kicker className="mb-2.5">Connected · {connectedRows.length}</Kicker>
          {list.loading ? (
            <Skeleton className="h-[220px] w-full rounded-xl" />
          ) : list.error ? (
            <div className="rounded-xl border bg-card px-6 py-5">
              <div className="text-[13.5px] font-medium text-destructive">Failed to load connections</div>
              <div className="mt-1 text-xs text-muted-foreground">{list.error.message}</div>
            </div>
          ) : connectedRows.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title={query || categoryFilter ? "No connected integrations match" : "No connections yet"}
              description={
                query || categoryFilter
                  ? "Clear the filters, or connect a provider below."
                  : "Connect a provider below — GitHub for repositories, Slack for notifications — and plans can act on it."
              }
            />
          ) : (
            <ListCard>
              {connectedRows.map((c) => (
                <ConnectedRow
                  key={c.id}
                  href={`/orgs/${orgSlug}/integrations/${c.provider}`}
                  provider={c.provider}
                  name={connectionProviderName(c)}
                  status={c.status}
                  meta={connectedMetaLine(c, { brokeredCount: brokeredCounts.get(c.id) ?? 0 })}
                />
              ))}
            </ListCard>
          )}
        </section>
      ) : null}

      {/* Available section */}
      {statusFilter !== "connected" ? (
        <section className="mt-8">
          <Kicker className="mb-2.5">Available · {availableDescriptors.length}</Kicker>
          {registryQuery.loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Skeleton className="h-[128px] rounded-xl" />
              <Skeleton className="h-[128px] rounded-xl" />
              <Skeleton className="h-[128px] rounded-xl" />
            </div>
          ) : registryQuery.error ? (
            <div className="rounded-xl border bg-card px-6 py-5">
              <div className="text-[13.5px] font-medium">Integration directory unavailable</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Could not load the integration registry — connected providers keep working; new connections
                are paused until it recovers. {registryQuery.error.message}
              </div>
            </div>
          ) : availableDescriptors.length === 0 ? (
            <EmptyState icon={Plug} title="Nothing else to connect" description="Every available provider is connected." />
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {availableDescriptors.map((d) => (
                <ProviderCard
                  key={d.id}
                  descriptor={d}
                  state={cardState(d, connections)}
                  waiting={connectingProvider === d.id}
                  disabled={connectingProvider !== null}
                  onConnect={() => void connect(d)}
                  onUpgrade={() => router.push(`/orgs/${orgSlug}/settings/billing`)}
                />
              ))}
            </div>
          )}
        </section>
      ) : null}

      {/* Roadmap strip */}
      {roadmapDescriptors.length > 0 ? (
        <section className="mt-8">
          <Kicker className="mb-2.5">On the roadmap</Kicker>
          <div className="rounded-xl border border-dashed bg-muted px-6 py-5">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {roadmapListSentence(roadmapDescriptors.map((d) => d.displayName))} coming soon.{" "}
              <span className="font-medium text-foreground">Get notified</span> when they land.
            </p>
          </div>
        </section>
      ) : null}

      <ConnectPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        descriptors={registry}
        connections={connections}
        loading={registryQuery.loading}
        connectingProvider={connectingProvider}
        onConnect={(d) => {
          setPickerOpen(false);
          void connect(d);
        }}
        onUpgrade={() => {
          setPickerOpen(false);
          router.push(`/orgs/${orgSlug}/settings/billing`);
        }}
      />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Connected row — compact directory row; Manage → the provider detail page.
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<string, Tone> = {
  active: "success",
  pending: "warning",
  suspended: "warning",
  revoked: "error",
};

export function ConnectedRow({
  href,
  provider,
  name,
  status,
  meta,
}: {
  href: string;
  provider: string;
  name: string;
  status: string;
  meta: string;
}) {
  const tone = STATUS_TONE[status] ?? "neutral";
  const statusLabel = status === "active" ? "Connected" : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <Link
      href={href}
      className="group flex items-center gap-3.5 border-t border-border/50 px-5 py-4 first:border-t-0 transition-colors duration-100 hover:bg-muted"
    >
      <ProviderTile provider={provider} size={40} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[15px] font-semibold leading-tight">{name}</span>
          <Pill tone={tone} dot live={status === "pending"}>
            {statusLabel}
          </Pill>
        </div>
        <div className="mt-[3px] truncate text-[12.5px] text-muted-foreground">
          <span className="font-mono text-[11.5px]">{meta}</span>
        </div>
      </div>
      <span className="flex shrink-0 items-center gap-2">
        <span className={cn(buttonVariants({ variant: "outline", size: "sm" }), "pointer-events-none")}>
          Manage
        </span>
        <ChevronRight aria-hidden className="h-4 w-4 text-muted-foreground/50" />
      </span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Available provider card — a pure function of descriptor + card state.
// ---------------------------------------------------------------------------

export function ProviderCard({
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
    <div className="flex flex-col rounded-xl border bg-card px-5 py-[18px]">
      <div className="flex items-center gap-2.5">
        <Icon className="h-[18px] w-[18px] shrink-0 text-secondary-foreground" strokeWidth={1.8} aria-hidden />
        <span className="text-[14px] font-semibold">{descriptor.displayName}</span>
        {state === "locked" ? (
          <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={onUpgrade}>
            Upgrade
          </Button>
        ) : state === "configure" ? (
          <span className="ml-auto shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
            Not configured
          </span>
        ) : (
          <Button variant="outline" size="sm" className="ml-auto shrink-0" disabled={disabled} onClick={onConnect}>
            {waiting ? `Waiting for ${descriptor.displayName}…` : "Connect"}
          </Button>
        )}
      </div>
      <Kicker className="mt-3">{CATEGORY_LABELS[descriptor.category]}</Kicker>
      <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
        {state === "configure"
          ? `${descriptor.tagline} This environment has no ${descriptor.displayName} credentials registered yet — an operator sets them per environment.`
          : descriptor.tagline}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect picker (IX5) — the global "+ Connect" dialog. A registry-driven
// provider picker: lists every connectable provider (available/locked/
// configure) grouped by category, with a search. Clicking dispatches the same
// connect() the cards use (popup+poll or the provider space's flow).
// ---------------------------------------------------------------------------

export function ConnectPicker({
  open,
  onOpenChange,
  descriptors,
  connections,
  loading,
  connectingProvider,
  onConnect,
  onUpgrade,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  descriptors: readonly IntegrationDescriptor[];
  connections: readonly PublicConnection[];
  loading: boolean;
  connectingProvider: string | null;
  onConnect: (descriptor: IntegrationDescriptor) => void;
  onUpgrade: () => void;
}) {
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const connectable = descriptors.filter((d) => {
    const state = cardState(d, connections);
    if (!(state === "available" || state === "locked" || state === "configure")) return false;
    return matchesSearch(d, q, CATEGORY_LABELS[d.category]);
  });
  const groups = groupByCategory(connectable);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect an integration</DialogTitle>
          <DialogDescription>
            Pick a provider — Orun acts on it without storing your credentials.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search providers" aria-label="Search providers" className="h-9 pl-9" autoFocus />
        </div>

        <div className="mt-1 max-h-[52vh] space-y-4 overflow-y-auto">
          {loading ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : groups.length === 0 ? (
            <div className="px-1 py-6 text-center text-[13px] text-muted-foreground">
              {q ? "No providers match." : "Everything available is already connected."}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.category}>
                <Kicker className="mb-2">{group.label}</Kicker>
                <div className="space-y-1.5">
                  {group.items.map((d) => {
                    const state = cardState(d, connections);
                    const Icon = ICONS[providerIconName(d)] ?? Plug;
                    return (
                      <div key={d.id} className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5">
                        <Icon className="h-[18px] w-[18px] shrink-0 text-secondary-foreground" strokeWidth={1.8} aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold">{d.displayName}</div>
                          <div className="truncate text-[12px] text-muted-foreground">{d.tagline}</div>
                        </div>
                        {state === "locked" ? (
                          <Button variant="outline" size="sm" className="shrink-0" onClick={onUpgrade}>
                            Upgrade
                          </Button>
                        ) : state === "configure" ? (
                          <span className="shrink-0 rounded-[10px] border border-border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
                            Not configured
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="shrink-0"
                            disabled={connectingProvider !== null}
                            onClick={() => onConnect(d)}
                          >
                            {connectingProvider === d.id ? "Waiting…" : "Connect"}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
