"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Bell,
  ChevronDown,
  Flame,
  Info,
  Layers,
  Radio,
  RefreshCw,
  X,
  type LucideIcon,
} from "lucide-react";
import type { PublicEvent, PublicEventGroup, PublicEventGroupMember } from "@saas/contracts/events";
import { eventDedupKey } from "@saas/contracts/event-catalog";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  appendEventPage,
  buildEventFilterChips,
  buildEventsQuery,
  EMPTY_EVENT_FILTERS,
  EMPTY_EVENT_LOG,
  EVENT_CATEGORY_OPTIONS,
  EVENT_SEVERITY_OPTIONS,
  EVENT_TIME_PRESETS,
  EVENT_TYPE_GLOB_OPTIONS,
  EVENT_TYPE_OPTIONS,
  eventMatchesClientFilters,
  formatRelativeTime,
  groupEventsByDay,
  hasActiveEventFilters,
  hasMoreEvents,
  prependNewEvents,
  presetFromIso,
  severityAccent,
  type EventFilterFormValues,
  type EventLogState,
  type EventTimePreset,
} from "@/components/events/event-log";

const SEVERITY_ICONS: Record<string, LucideIcon> = {
  Info,
  Bell,
  AlertTriangle,
  AlertOctagon,
  Flame,
};

const SEVERITY_TONE: Record<string, string> = {
  slate: "bg-muted text-muted-foreground",
  blue: "bg-sky-500/10 text-sky-500",
  amber: "bg-amber-500/10 text-amber-500",
  rose: "bg-rose-500/10 text-rose-500",
  red: "bg-red-500/10 text-red-500",
};

const POLL_INTERVAL_MS = 5000;

/** Debounce a fast-changing text value before it drives refetches. */
function useDebounced<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/** datetime-local value → ISO Z (empty/invalid → empty string). */
function localToIso(value: string): string {
  if (!value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export default function EventsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} orgSlug={slug} />}</OrgScope>;
}

function Inner({ orgId, orgSlug }: { orgId: string; orgSlug: string }) {
  const { client } = useSession();
  const searchParams = useSearchParams();

  // Seed toolbar state from the querystring (URL-driven, shareable).
  const [type, setType] = React.useState(searchParams?.get("type") ?? "");
  const [severity, setSeverity] = React.useState(searchParams?.get("severity") ?? "all");
  const [category, setCategory] = React.useState(searchParams?.get("category") ?? "all");
  const [sourceInput, setSourceInput] = React.useState(searchParams?.get("source") ?? "");
  const [projectInput, setProjectInput] = React.useState(searchParams?.get("project") ?? "");
  const [environmentInput, setEnvironmentInput] = React.useState(searchParams?.get("environment") ?? "");
  const [preset, setPreset] = React.useState<EventTimePreset>((searchParams?.get("range") as EventTimePreset) ?? "any");
  const [customFrom, setCustomFrom] = React.useState("");
  const [customTo, setCustomTo] = React.useState("");
  const [advancedOpen, setAdvancedOpen] = React.useState(
    Boolean(searchParams?.get("source") || searchParams?.get("project") || searchParams?.get("environment")),
  );
  const [livePoll, setLivePoll] = React.useState(false);
  const [tab, setTab] = React.useState<"stream" | "groups">("stream");
  const [refreshNonce, setRefreshNonce] = React.useState(0);

  const typeDebounced = useDebounced(type);
  const source = useDebounced(sourceInput);
  const project = useDebounced(projectInput);
  const environment = useDebounced(environmentInput);

  const applied: EventFilterFormValues = React.useMemo(
    () => ({
      ...EMPTY_EVENT_FILTERS,
      type: typeDebounced.trim(),
      severity: severity === "all" ? "" : severity,
      category: category === "all" ? "" : category,
      source: source.trim(),
      project: project.trim(),
      environment: environment.trim(),
      from: preset === "custom" ? localToIso(customFrom) : (presetFromIso(preset) ?? ""),
      to: preset === "custom" ? localToIso(customTo) : "",
    }),
    // refreshNonce intentionally re-derives `from` for relative presets.
    [typeDebounced, severity, category, source, project, environment, preset, customFrom, customTo, refreshNonce],
  );
  const appliedKey = JSON.stringify(applied);

  // Persist filters to the URL without a Next navigation (no scroll/refetch loop).
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams();
    if (applied.type) sp.set("type", applied.type);
    if (applied.severity) sp.set("severity", applied.severity);
    if (applied.category) sp.set("category", applied.category);
    if (applied.source) sp.set("source", applied.source);
    if (applied.project) sp.set("project", applied.project);
    if (applied.environment) sp.set("environment", applied.environment);
    if (preset !== "any") sp.set("range", preset);
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
  }, [applied, preset]);

  const [log, setLog] = React.useState<EventLogState>(EMPTY_EVENT_LOG);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);
  const [selected, setSelected] = React.useState<PublicEvent | null>(null);

  const loadFirstPage = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await wrap(() => client.events.listEventsPage(orgId, buildEventsQuery(applied)));
    if (res.ok) {
      setLog(appendEventPage(EMPTY_EVENT_LOG, res.data, /* reset */ true));
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setLog(EMPTY_EVENT_LOG);
    }
    setLoading(false);
  }, [client, orgId, appliedKey]);

  React.useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = React.useCallback(async () => {
    if (log.cursor === null || loadingMore) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.events.listEventsPage(orgId, buildEventsQuery(applied, log.cursor ?? undefined)),
    );
    if (res.ok) setLog((prev) => appendEventPage(prev, res.data));
    else setError({ code: res.error.code, message: res.error.message });
    setLoadingMore(false);
  }, [client, orgId, appliedKey, log.cursor, loadingMore]);

  // Live poll: re-fetch the first page on an interval and prepend new rows.
  // Paused when the tab isn't the stream; re-created (so it pauses/re-anchors)
  // whenever the applied filters change.
  React.useEffect(() => {
    if (!livePoll || tab !== "stream") return;
    let cancelled = false;
    const poll = async () => {
      const res = await wrap(() => client.events.listEventsPage(orgId, buildEventsQuery(applied)));
      if (cancelled || !res.ok) return;
      setLog((prev) => prependNewEvents(prev, res.data.events));
    };
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [livePoll, tab, client, orgId, appliedKey]);

  const chips = buildEventFilterChips(applied);
  const filtersActive = hasActiveEventFilters(applied);

  // Severity floor + category can't be expressed by the read API, so filter the
  // loaded rows client-side (see event-log.ts).
  const visible = React.useMemo(
    () => log.events.filter((e) => eventMatchesClientFilters(e, applied)),
    [log.events, applied],
  );
  const groups = groupEventsByDay(visible);

  const clearChip = (key: keyof EventFilterFormValues) => {
    switch (key) {
      case "type":
        setType("");
        break;
      case "severity":
        setSeverity("all");
        break;
      case "category":
        setCategory("all");
        break;
      case "source":
        setSourceInput("");
        break;
      case "project":
        setProjectInput("");
        break;
      case "environment":
        setEnvironmentInput("");
        break;
      case "from":
      case "to":
        setPreset("any");
        setCustomFrom("");
        setCustomTo("");
        break;
    }
  };

  const clearAll = () => {
    setType("");
    setSeverity("all");
    setCategory("all");
    setSourceInput("");
    setProjectInput("");
    setEnvironmentInput("");
    setPreset("any");
    setCustomFrom("");
    setCustomTo("");
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Events</h1>
          <p className="text-sm text-muted-foreground">
            The live event stream for this workspace — everything the platform emits, faceted and searchable.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Radio className={cn("h-3.5 w-3.5", livePoll && "text-emerald-500")} />
            Live
            <Switch checked={livePoll} onCheckedChange={setLivePoll} aria-label="Live poll" />
          </label>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Refresh"
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "stream" | "groups")}>
        <TabsList>
          <TabsTrigger value="stream">
            <Activity className="mr-1.5 h-3.5 w-3.5" />
            Stream
          </TabsTrigger>
          <TabsTrigger value="groups">
            <Layers className="mr-1.5 h-3.5 w-3.5" />
            Correlation stories
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stream">
          {/* Filter toolbar — selects apply instantly, text inputs debounce. */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={type}
                onChange={(e) => setType(e.target.value)}
                placeholder="Type glob (scm.* / notification.sent / *)"
                aria-label="Event type"
                className="h-8 w-[280px] text-xs"
                list="event-type-options"
              />
              <datalist id="event-type-options">
                {EVENT_TYPE_GLOB_OPTIONS.map((t) => (
                  <option key={t} value={t} />
                ))}
                {EVENT_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>

              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Severity floor">
                  <SelectValue placeholder="Severity" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any severity</SelectItem>
                  {EVENT_SEVERITY_OPTIONS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s} and up
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Category">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {EVENT_CATEGORY_OPTIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select value={preset} onValueChange={(v) => setPreset(v as EventTimePreset)}>
                <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Time range">
                  <SelectValue placeholder="Time range" />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TIME_PRESETS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                aria-expanded={advancedOpen}
              >
                Advanced
                <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", advancedOpen && "rotate-180")} />
              </button>
            </div>

            {preset === "custom" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="datetime-local"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-label="From"
                  className="h-8 w-[210px] text-xs"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="datetime-local"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-label="To"
                  className="h-8 w-[210px] text-xs"
                />
              </div>
            ) : null}

            {advancedOpen ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={sourceInput}
                  onChange={(e) => setSourceInput(e.target.value)}
                  placeholder="Source (events-worker, scm…)"
                  aria-label="Source"
                  className="h-8 w-[220px] text-xs"
                />
                <Input
                  value={projectInput}
                  onChange={(e) => setProjectInput(e.target.value)}
                  placeholder="Project id (prj_…)"
                  aria-label="Project id"
                  className="h-8 w-[200px] text-xs"
                />
                <Input
                  value={environmentInput}
                  onChange={(e) => setEnvironmentInput(e.target.value)}
                  placeholder="Environment id (env_…)"
                  aria-label="Environment id"
                  className="h-8 w-[200px] text-xs"
                />
              </div>
            ) : null}

            {chips.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {chips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => clearChip(chip.key)}
                    className="group inline-flex max-w-[280px] items-center gap-1 rounded-full border bg-muted/50 py-0.5 pl-2.5 pr-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    aria-label={`Remove filter ${chip.label}`}
                  >
                    <span className="truncate">{chip.label}</span>
                    <X className="h-3 w-3 opacity-60 group-hover:opacity-100" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-[11px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  Clear all
                </button>
              </div>
            ) : null}
          </div>

          <div className="mt-4">
            {loading ? (
              <Card>
                <CardContent className="space-y-2 pt-6">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </CardContent>
              </Card>
            ) : error ? (
              <Card>
                <CardHeader>
                  <CardTitle className="text-destructive">{error.code}</CardTitle>
                  <CardDescription>{error.message}</CardDescription>
                </CardHeader>
              </Card>
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No matching events"
                description={
                  filtersActive
                    ? "No events match the current filters. Widen the time range or clear a filter."
                    : "Events emitted in this workspace will stream in here."
                }
                {...(filtersActive ? { primaryAction: { label: "Clear filters", onClick: clearAll } } : {})}
              />
            ) : (
              <div className="space-y-5">
                {groups.map((group) => (
                  <section key={group.key} aria-label={group.label}>
                    <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {group.label}
                    </h2>
                    <Card className="divide-y divide-border p-0">
                      {group.events.map((e) => (
                        <EventRow key={e.id} event={e} onOpen={() => setSelected(e)} />
                      ))}
                    </Card>
                  </section>
                ))}

                {hasMoreEvents(log) ? (
                  <div className="flex justify-center pt-1">
                    <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                      Load more
                    </Button>
                  </div>
                ) : (
                  <p className="pt-1 text-center text-[11px] text-muted-foreground">End of the stream for these filters.</p>
                )}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="groups">
          <GroupStories orgId={orgId} onOpenEvent={setSelected} />
        </TabsContent>
      </Tabs>

      <EventDetailSheet
        orgSlug={orgSlug}
        event={selected}
        onClose={() => setSelected(null)}
        onViewStories={() => {
          setSelected(null);
          setTab("groups");
        }}
      />
    </div>
  );
}

function EventRow({ event, onOpen }: { event: PublicEvent; onOpen: () => void }) {
  const accent = severityAccent(event.severity);
  const Icon = SEVERITY_ICONS[accent.icon] ?? Info;
  const absolute = new Date(event.occurredAt).toLocaleString();
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
    >
      <span
        className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", SEVERITY_TONE[accent.tone])}
        aria-hidden
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{event.title}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="font-mono">{event.type}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{event.source}</span>
          {event.subject?.name ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{event.subject.name}</span>
            </>
          ) : null}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-0.5">
        <Badge variant="secondary" className="hidden text-[10px] sm:inline-flex">
          {event.severity}
        </Badge>
        <time className="whitespace-nowrap text-[11px] text-muted-foreground" title={absolute} dateTime={event.occurredAt}>
          {formatRelativeTime(event.occurredAt)}
        </time>
        <ChevronDown className="h-3.5 w-3.5 -rotate-90 text-muted-foreground/60" aria-hidden />
      </span>
    </button>
  );
}

function EventDetailSheet({
  orgSlug,
  event,
  onClose,
  onViewStories,
}: {
  orgSlug: string;
  event: PublicEvent | null;
  onClose: () => void;
  onViewStories: () => void;
}) {
  const dedupKey = event
    ? eventDedupKey(event.type, {
        subject: event.subject,
        tenant: { orgId: event.orgId },
        payload: event.payload,
      })
    : null;

  return (
    <Sheet open={event !== null} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        {event ? (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8 text-base">{event.title}</SheetTitle>
              <p className="font-mono text-xs text-muted-foreground">{event.type}</p>
            </SheetHeader>

            <div className="mt-2 flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/orgs/${orgSlug}/settings/notifications/rules?type=${encodeURIComponent(event.type)}&new=1`}>
                  Create rule from this event
                </Link>
              </Button>
              {dedupKey ? (
                <Button size="sm" variant="outline" onClick={onViewStories}>
                  <Layers className="mr-1.5 h-3.5 w-3.5" />
                  View correlation stories
                </Button>
              ) : null}
            </div>

            <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
              <DetailPair label="Event id" value={event.id} mono copyValue={event.id} />
              <DetailPair label="Occurred" value={new Date(event.occurredAt).toLocaleString()} />
              <DetailPair label="Severity" value={event.severity} />
              <DetailPair label="Category" value={event.category} />
              <DetailPair label="Version" value={String(event.version)} />
              <DetailPair label="Source" value={event.source} mono />
              <DetailPair label="Actor" value={`${event.actor.type}:${event.actor.id}`} mono copyValue={event.actor.id} />
              <DetailPair
                label="Subject"
                value={`${event.subject.kind}:${event.subject.id}`}
                mono
                copyValue={event.subject.id}
              />
              {event.projectId ? <DetailPair label="Project" value={event.projectId} mono copyValue={event.projectId} /> : null}
              {event.environmentId ? (
                <DetailPair label="Environment" value={event.environmentId} mono copyValue={event.environmentId} />
              ) : null}
              <DetailPair label="Request" value={event.requestId} mono copyValue={event.requestId} />
              {event.correlationId ? (
                <DetailPair label="Correlation" value={event.correlationId} mono copyValue={event.correlationId} />
              ) : null}
              {event.causationId ? (
                <DetailPair label="Causation" value={event.causationId} mono copyValue={event.causationId} />
              ) : null}
              {dedupKey ? <DetailPair label="Dedup key" value={dedupKey} mono copyValue={dedupKey} /> : null}
            </dl>

            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Payload</span>
                <CopyButton value={JSON.stringify(event.payload, null, 2)} variant="ghost" size="sm" />
              </div>
              <pre className="max-h-[420px] overflow-auto rounded-md border bg-background p-3 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function GroupStories({
  orgId,
  onOpenEvent,
}: {
  orgId: string;
  onOpenEvent: (event: PublicEvent) => void;
}) {
  const { client } = useSession();
  const [status, setStatus] = React.useState<"all" | "open" | "closed">("open");
  const [items, setItems] = React.useState<ReadonlyArray<PublicEventGroup>>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await wrap(() =>
      client.eventGroups.listPage(orgId, status === "all" ? {} : { status }),
    );
    if (res.ok) {
      setItems(res.data.eventGroups);
      setCursor(res.data.cursor);
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setItems([]);
    }
    setLoading(false);
  }, [client, orgId, status]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const loadMore = React.useCallback(async () => {
    if (cursor === null || loadingMore) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.eventGroups.listPage(orgId, status === "all" ? { cursor } : { status, cursor }),
    );
    if (res.ok) {
      setItems((prev) => [...prev, ...res.data.eventGroups]);
      setCursor(res.data.cursor);
    }
    setLoadingMore(false);
  }, [client, orgId, status, cursor, loadingMore]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v as "all" | "open" | "closed")}>
          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Group status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open stories</SelectItem>
            <SelectItem value="closed">Closed stories</SelectItem>
            <SelectItem value="all">All stories</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{error.code}</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No correlation stories"
          description="Dedup/correlation groups appear here when repeated or related events are folded into a single story."
        />
      ) : (
        <div className="space-y-3">
          {items.map((g) => (
            <GroupCard key={g.id} orgId={orgId} group={g} onOpenEvent={onOpenEvent} />
          ))}
          {cursor !== null ? (
            <div className="flex justify-center pt-1">
              <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function GroupCard({
  orgId,
  group,
  onOpenEvent,
}: {
  orgId: string;
  group: PublicEventGroup;
  onOpenEvent: (event: PublicEvent) => void;
}) {
  const { client } = useSession();
  const accent = severityAccent(group.maxSeverity);
  const [open, setOpen] = React.useState(false);
  const [members, setMembers] = React.useState<ReadonlyArray<PublicEventGroupMember> | null>(null);
  const [loading, setLoading] = React.useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && members === null && !loading) {
      setLoading(true);
      const res = await wrap(() => client.eventGroups.get(orgId, group.id));
      if (res.ok) setMembers(res.data.members);
      setLoading(false);
    }
  };

  const openMember = async (eventId: string) => {
    const res = await wrap(() => client.events.getEvent(orgId, eventId));
    if (res.ok) onOpenEvent(res.data.event);
  };

  return (
    <Card className="p-0">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
      >
        <span
          className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full", SEVERITY_TONE[accent.tone])}
          aria-hidden
        >
          <Layers className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-mono text-sm">{group.groupKey}</span>
            <Badge variant={group.status === "open" ? "default" : "secondary"} className="text-[10px]">
              {group.status}
            </Badge>
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{group.maxSeverity}</span>
            <span aria-hidden>·</span>
            <span>{group.eventCount} events</span>
            <span aria-hidden>·</span>
            <span title={new Date(group.firstAt).toLocaleString()}>first {formatRelativeTime(group.firstAt)}</span>
            <span aria-hidden>·</span>
            <span title={new Date(group.lastAt).toLocaleString()}>last {formatRelativeTime(group.lastAt)}</span>
          </span>
        </span>
        <ChevronDown className={cn("mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open ? (
        <div className="border-t border-dashed bg-muted/30 px-4 py-3">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : members && members.length > 0 ? (
            <ol className="space-y-1.5">
              {members.map((m) => (
                <li key={m.eventId} className="flex items-center justify-between gap-3 text-xs">
                  <button
                    type="button"
                    onClick={() => void openMember(m.eventId)}
                    className="truncate font-mono text-primary underline-offset-2 hover:underline"
                  >
                    {m.eventId}
                  </button>
                  <time className="whitespace-nowrap text-muted-foreground" title={new Date(m.addedAt).toLocaleString()} dateTime={m.addedAt}>
                    {formatRelativeTime(m.addedAt)}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">No members recorded for this story.</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}

function DetailPair({
  label,
  value,
  mono = false,
  copyValue,
}: {
  label: string;
  value: string;
  mono?: boolean;
  copyValue?: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("truncate", mono && "font-mono")} title={value}>
        {value}
      </dd>
      {copyValue ? <CopyButton value={copyValue} variant="ghost" size="sm" className="h-5 w-5 shrink-0 p-0" /> : null}
    </div>
  );
}
