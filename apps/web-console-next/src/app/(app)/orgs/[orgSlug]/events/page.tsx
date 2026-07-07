"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Activity, Check, ChevronDown, Layers, RefreshCw, X } from "lucide-react";
import type { PublicEvent, PublicEventGroup, PublicEventGroupMember } from "@saas/contracts/events";
import { eventDedupKey } from "@saas/contracts/event-catalog";
import { OrgScope } from "@/components/shell/org-scope";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Chip,
  ChipDivider,
  ChipRow,
  Kicker,
  ListCard,
  PageHeader,
  Pill,
  Screen,
  StatusDot,
  StatusText,
  toneDot,
  type Tone,
} from "@/components/ui/northwind";
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
  type EventFilterFormValues,
  type EventLogState,
  type EventTimePreset,
} from "@/components/events/event-log";

/** Severity ladder → Northwind tone (bar, pill, and dot colors). */
const SEVERITY_NW_TONE: Record<string, Tone> = {
  info: "info",
  notice: "success",
  warning: "warning",
  error: "error",
  critical: "error",
};

function severityTone(severity: string): Tone {
  return SEVERITY_NW_TONE[severity] ?? "neutral";
}

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

/** ISO → local wall-clock HH:MM:SS for the 64px time column. */
function formatClockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
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

  const presetLabel = EVENT_TIME_PRESETS.find((p) => p.value === preset)?.label ?? "Any time";

  return (
    <Screen>
      <PageHeader
        title="Events"
        description="The raw event bus — everything the platform emitted, as it happened."
        actions={
          <>
            <button
              type="button"
              onClick={() => setLivePoll((v) => !v)}
              aria-pressed={livePoll}
              className={cn(
                "inline-flex items-center gap-2 rounded-[9px] border px-3.5 py-[7px] text-[12.5px] font-medium transition-colors",
                livePoll
                  ? "border-info/30 bg-info-soft text-info"
                  : "border-border bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground",
              )}
            >
              <StatusDot tone={livePoll ? "info" : "neutral"} live={livePoll} />
              {livePoll ? "Live tail on" : "Live tail off"}
            </button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Refresh"
              onClick={() => setRefreshNonce((n) => n + 1)}
              disabled={loading}
            >
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} strokeWidth={1.8} />
            </Button>
          </>
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as "stream" | "groups")} className="mt-[26px]">
        <TabsList className="h-auto gap-[7px] bg-transparent p-0">
          <TabsTrigger value="stream" className={tabTriggerCls}>
            Stream
          </TabsTrigger>
          <TabsTrigger value="groups" className={tabTriggerCls}>
            Correlation stories
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stream" className="mt-5">
          {/* Filter toolbar — dropdown chips apply instantly, the query input debounces. */}
          <div className="space-y-2.5">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-[7px]">
              <Input
                value={type}
                onChange={(e) => setType(e.target.value)}
                placeholder="type: run.*"
                aria-label="Event type"
                className="w-full rounded-[9px] bg-card font-mono placeholder:text-muted-foreground/70 sm:h-[31px] sm:w-[240px] sm:text-[12.5px]"
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

              <ChipRow className="sm:min-w-0 sm:flex-1">
                <ChipMenu
                  label={severity === "all" ? "Severity ≥ any" : `Severity ≥ ${severity}`}
                  active={severity !== "all"}
                  value={severity}
                  onChange={setSeverity}
                  ariaLabel="Severity floor"
                  options={[
                    { value: "all", label: "Any severity" },
                    ...EVENT_SEVERITY_OPTIONS.map((s) => ({ value: s, label: `${s} and up` })),
                  ]}
                />
                <ChipMenu
                  label={`Category: ${category}`}
                  active={category !== "all"}
                  value={category}
                  onChange={setCategory}
                  ariaLabel="Category"
                  options={[
                    { value: "all", label: "All categories" },
                    ...EVENT_CATEGORY_OPTIONS.map((c) => ({ value: c, label: c })),
                  ]}
                />
                <ChipMenu
                  label={presetLabel}
                  active={preset !== "any"}
                  value={preset}
                  onChange={(v) => setPreset(v as EventTimePreset)}
                  ariaLabel="Time range"
                  options={EVENT_TIME_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
                />
                <ChipDivider />
                <Chip
                  active={advancedOpen}
                  onClick={() => setAdvancedOpen((o) => !o)}
                  aria-expanded={advancedOpen}
                >
                  Advanced
                  <ChevronDown
                    className={cn("h-3 w-3 opacity-70 transition-transform", advancedOpen && "rotate-180")}
                    strokeWidth={1.8}
                    aria-hidden
                  />
                </Chip>
              </ChipRow>

              <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                {visible.length} {visible.length === 1 ? "event" : "events"}
              </span>
            </div>

            {preset === "custom" ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="datetime-local"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                  aria-label="From"
                  className="w-[210px] rounded-[9px] sm:h-[31px] sm:text-xs"
                />
                <span className="text-xs text-muted-foreground">to</span>
                <Input
                  type="datetime-local"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                  aria-label="To"
                  className="w-[210px] rounded-[9px] sm:h-[31px] sm:text-xs"
                />
              </div>
            ) : null}

            {advancedOpen ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={sourceInput}
                  onChange={(e) => setSourceInput(e.target.value)}
                  placeholder="source: events-worker"
                  aria-label="Source"
                  className="w-full rounded-[9px] font-mono sm:h-[31px] sm:w-[220px] sm:text-xs"
                />
                <Input
                  value={projectInput}
                  onChange={(e) => setProjectInput(e.target.value)}
                  placeholder="project: prj_…"
                  aria-label="Project id"
                  className="w-full rounded-[9px] font-mono sm:h-[31px] sm:w-[200px] sm:text-xs"
                />
                <Input
                  value={environmentInput}
                  onChange={(e) => setEnvironmentInput(e.target.value)}
                  placeholder="environment: env_…"
                  aria-label="Environment id"
                  className="w-full rounded-[9px] font-mono sm:h-[31px] sm:w-[200px] sm:text-xs"
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
                    className="group inline-flex max-w-[280px] items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-2.5 pr-1.5 font-mono text-[11px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
                    aria-label={`Remove filter ${chip.label}`}
                  >
                    <span className="truncate">{chip.label}</span>
                    <X className="h-3 w-3 opacity-60 group-hover:opacity-100" strokeWidth={1.8} />
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

          <div className="mt-1">
            {loading ? (
              <ListCard className="mt-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3.5 border-t border-border/50 px-5 py-3 first:border-t-0">
                    <Skeleton className="h-[30px] w-[3px] rounded-[2px]" />
                    <Skeleton className="h-3.5 w-[64px]" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3.5 w-2/5" />
                      <Skeleton className="h-3 w-3/5" />
                    </div>
                    <Skeleton className="h-4 w-12 rounded-full" />
                  </div>
                ))}
              </ListCard>
            ) : error ? (
              <Card className="mt-6 px-5 py-4">
                <StatusText tone="error" className="font-mono text-[12.5px] font-semibold">
                  {error.code}
                </StatusText>
                <p className="mt-1.5 text-[13px] text-muted-foreground">{error.message}</p>
              </Card>
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="No matching events"
                className="mt-6"
                description={
                  filtersActive
                    ? "No events match the current filters. Widen the time range or clear a filter."
                    : "Events emitted in this workspace will stream in here."
                }
                {...(filtersActive ? { primaryAction: { label: "Clear filters", onClick: clearAll } } : {})}
              />
            ) : (
              <>
                {groups.map((group) => (
                  <section key={group.key} aria-label={group.label}>
                    <Kicker className="mb-[9px] mt-6">{group.label}</Kicker>
                    <ListCard>
                      {group.events.map((e) => (
                        <EventRow key={e.id} event={e} onOpen={() => setSelected(e)} />
                      ))}
                    </ListCard>
                  </section>
                ))}

                {hasMoreEvents(log) ? (
                  <div className="mt-4 flex justify-center">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto px-[18px] py-2 text-[12.5px] font-normal text-muted-foreground"
                      onClick={() => void loadMore()}
                      loading={loadingMore}
                    >
                      Load more
                    </Button>
                  </div>
                ) : (
                  <p className="mt-4 text-center text-[11px] text-muted-foreground">
                    End of the stream for these filters.
                  </p>
                )}
              </>
            )}
          </div>
        </TabsContent>

        <TabsContent value="groups" className="mt-5">
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
    </Screen>
  );
}

/** Northwind chip-styled tab trigger (the shared Tabs primitive is still the gray shadcn pill). */
const tabTriggerCls =
  "rounded-full border border-border bg-card px-[13px] py-[5px] text-[12.5px] font-normal text-muted-foreground shadow-none transition-colors hover:border-foreground/25 hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-primary data-[state=active]:font-medium data-[state=active]:text-primary-foreground data-[state=active]:shadow-none";

/** Filter chip that opens a single-select dropdown (severity / category / range). */
function ChipMenu({
  label,
  active,
  value,
  options,
  onChange,
  ariaLabel,
}: {
  label: string;
  active: boolean;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Chip active={active} aria-label={ariaLabel}>
          {label}
          <ChevronDown className="h-3 w-3 opacity-70" strokeWidth={1.8} aria-hidden />
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[160px]">
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onSelect={() => onChange(o.value)}
            className={cn("text-[12.5px]", o.value === value && "font-medium")}
          >
            <Check
              className={cn("h-3.5 w-3.5", o.value === value ? "opacity-100" : "opacity-0")}
              strokeWidth={1.8}
              aria-hidden
            />
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function EventRow({ event, onOpen }: { event: PublicEvent; onOpen: () => void }) {
  const tone = severityTone(event.severity);
  const isError = tone === "error";
  const absolute = new Date(event.occurredAt).toLocaleString();
  const scope = event.environmentId ?? event.projectId ?? "org";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex min-h-[40px] w-full items-center gap-3 border-t border-border/50 px-4 py-3 text-left transition-colors first:border-t-0 sm:gap-3.5 sm:px-5",
        isError ? "bg-destructive-wash hover:bg-destructive-soft" : "hover:bg-muted",
      )}
    >
      <span className={cn("h-[30px] w-[3px] shrink-0 rounded-[2px]", toneDot[tone])} aria-hidden />
      <time
        className="w-[52px] shrink-0 font-mono text-xs text-muted-foreground sm:w-[64px]"
        dateTime={event.occurredAt}
        title={`${absolute} · ${formatRelativeTime(event.occurredAt)}`}
      >
        {formatClockTime(event.occurredAt)}
      </time>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px]">
          <span className="font-mono text-xs font-semibold text-foreground">{event.type}</span>
          <span className="text-muted-foreground"> — {event.title}</span>
        </span>
        <span className="mt-px block truncate font-mono text-[11px] text-muted-foreground/80">
          source: {event.source}
          {event.correlationId ? ` · corr: ${event.correlationId}` : ""}
          {` · ${scope}`}
        </span>
        <Pill tone={tone} className="mt-1.5 px-[9px] text-[11px] sm:hidden">
          {event.severity}
        </Pill>
      </span>
      <Pill tone={tone} className="hidden px-[9px] text-[11px] sm:inline-flex">
        {event.severity}
      </Pill>
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
      <SheetContent side="right" className="w-full overflow-y-auto p-6 sm:max-w-xl">
        {event ? (
          <>
            <SheetHeader className="space-y-0">
              <Kicker>Event</Kicker>
              <SheetTitle className="mt-2 pr-8 font-serif text-[22px] font-medium leading-snug tracking-[-0.01em]">
                {event.title}
              </SheetTitle>
              <p className="mt-1.5 font-mono text-xs text-muted-foreground">{event.type}</p>
            </SheetHeader>

            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={severityTone(event.severity)} dot className="text-[11px]">
                {event.severity}
              </Pill>
              <Pill tone="neutral" className="text-[11px]">
                {event.category}
              </Pill>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link href={`/orgs/${orgSlug}/settings/notifications/rules?type=${encodeURIComponent(event.type)}&new=1`}>
                  Create rule from this event
                </Link>
              </Button>
              {dedupKey ? (
                <Button size="sm" variant="outline" onClick={onViewStories}>
                  <Layers className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.8} />
                  View correlation stories
                </Button>
              ) : null}
            </div>

            <div className="rounded-xl border bg-card px-4 py-3">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
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
                {event.projectId ? (
                  <DetailPair label="Project" value={event.projectId} mono copyValue={event.projectId} />
                ) : null}
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
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <Kicker>Payload</Kicker>
                <CopyButton value={JSON.stringify(event.payload, null, 2)} variant="ghost" size="sm" />
              </div>
              <pre className="max-h-[420px] overflow-auto rounded-[10px] border bg-[#FCFCFC] p-3.5 font-mono text-[11px] leading-relaxed dark:bg-secondary">
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
      <ChipRow>
        {(
          [
            { value: "open", label: "Open stories" },
            { value: "closed", label: "Closed stories" },
            { value: "all", label: "All stories" },
          ] as const
        ).map((opt) => (
          <Chip key={opt.value} active={status === opt.value} onClick={() => setStatus(opt.value)}>
            {opt.label}
          </Chip>
        ))}
      </ChipRow>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <Card className="px-5 py-4">
          <StatusText tone="error" className="font-mono text-[12.5px] font-semibold">
            {error.code}
          </StatusText>
          <p className="mt-1.5 text-[13px] text-muted-foreground">{error.message}</p>
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
              <Button
                type="button"
                variant="outline"
                className="h-auto px-[18px] py-2 text-[12.5px] font-normal text-muted-foreground"
                onClick={() => void loadMore()}
                loading={loadingMore}
              >
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
  const tone = severityTone(group.maxSeverity);
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
    <div className="overflow-hidden rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => void toggle()}
        aria-expanded={open}
        className="flex min-h-[40px] w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted sm:gap-3.5 sm:px-5"
      >
        <span className={cn("h-[30px] w-[3px] shrink-0 rounded-[2px]", toneDot[tone])} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-mono text-xs font-semibold text-foreground">{group.groupKey}</span>
            <Pill tone={group.status === "open" ? "info" : "neutral"} className="px-[9px] text-[11px]">
              {group.status}
            </Pill>
          </span>
          <span className="mt-px block truncate font-mono text-[11px] text-muted-foreground/80">
            {group.eventCount} {group.eventCount === 1 ? "event" : "events"} · first{" "}
            {formatRelativeTime(group.firstAt)} · last {formatRelativeTime(group.lastAt)}
          </span>
        </span>
        <Pill tone={tone} className="px-[9px] text-[11px]">
          {group.maxSeverity}
        </Pill>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform", open && "rotate-180")}
          strokeWidth={1.8}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="border-t border-border/50 bg-muted/40 px-4 py-3 sm:px-5">
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
                    className="truncate font-mono text-[11.5px] text-link underline-offset-2 hover:underline"
                  >
                    {m.eventId}
                  </button>
                  <time
                    className="whitespace-nowrap text-[11.5px] text-muted-foreground"
                    title={new Date(m.addedAt).toLocaleString()}
                    dateTime={m.addedAt}
                  >
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
    </div>
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
      <dd className={cn("truncate text-secondary-foreground", mono && "font-mono text-[11.5px]")} title={value}>
        {value}
      </dd>
      {copyValue ? <CopyButton value={copyValue} variant="ghost" size="sm" className="h-5 w-5 shrink-0 p-0" /> : null}
    </div>
  );
}
