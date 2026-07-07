"use client";

/**
 * Usage & quota — Northwind restyle of the org metering surface (Task 0127 /
 * U11). Meter cards (quota check per common metric), the State-plane stock +
 * flow card, the Consumption explorer (metric + window query), and the quota
 * violations list. Pure helpers live in `@/components/usage/usage`.
 */

import * as React from "react";
import { useParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Kicker,
  MeterBar,
  PageHeader,
  Pill,
  QuietLink,
  Screen,
  type Tone,
} from "@/components/ui/northwind";
import { cn } from "@/lib/cn";
import { wrap } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import {
  DEFAULT_USAGE_FORM,
  RANGE_PRESETS,
  METRIC_SUGGESTIONS,
  buildUsageQuery,
  canQueryUsage,
  sortRollups,
  usageBarPercents,
  formatQuantity,
  formatBytes,
  formatBucket,
  STATE_USAGE_METRICS,
  buildViolationsQuery,
  appendViolationsPage,
  hasMoreViolations,
  isViolationOpen,
  formatPeriod,
  overagePercent,
  EMPTY_VIOLATIONS,
  type UsageFormValues,
  type BucketType,
  type RangePreset,
  type ViolationsState,
} from "@/components/usage/usage";
import type { CheckQuotaResponse, GetUsageSummaryResponse } from "@saas/contracts/metering";

export default function UsagePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  // Page-level period: drives the State-plane flow window and the violations
  // empty-state copy. The Consumption explorer keeps its own applied window.
  const [range, setRange] = React.useState<RangePreset>("30d");
  const preset = RANGE_PRESETS.find((p) => p.value === range) ?? RANGE_PRESETS[2]!;

  // Plan name for the header lede (shares the billing page's cache entry).
  const billing = useApiQuery(qk.billingSummary(orgId), () =>
    wrap(() => client.billing.getSummary(orgId)),
  );
  const planName = billing.data?.plan?.name ?? null;

  return (
    <Screen>
      <PageHeader
        title="Usage & quota"
        description={
          planName
            ? `What the workspace consumed, against what the ${planName} plan allows.`
            : "What the workspace consumed, against what your plan allows."
        }
        actions={<PeriodChip value={range} onChange={setRange} />}
      />
      <MeterCards orgId={orgId} />
      <StatePlaneUsage orgId={orgId} range={range} />
      <UsageSummary orgId={orgId} />
      <QuotaViolations orgId={orgId} periodLabel={preset.label} />
    </Screen>
  );
}

/** Header period chip: "Last 30 days ▾" bound to the page range presets. */
function PeriodChip({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (v: RangePreset) => void;
}) {
  const label = (RANGE_PRESETS.find((p) => p.value === value) ?? RANGE_PRESETS[2]!).label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-[9px] border bg-card px-3.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
        >
          {label}
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.8} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {RANGE_PRESETS.map((p) => (
          <DropdownMenuItem key={p.value} onSelect={() => onChange(p.value)}>
            {p.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Meter cards -------------------------------------------------------------
// One quota check per common billable metric key; cards render only for
// metrics that have a configured limit or recorded usage.

const METER_METRICS: ReadonlyArray<{ metric: string; label: string }> = [
  { metric: "build_minutes", label: "Build minutes" },
  { metric: "api_requests", label: "API requests" },
  { metric: "seats", label: "Seats" },
  { metric: "bandwidth_gb", label: "Bandwidth (GB)" },
  { metric: "storage_gb", label: "Storage (GB)" },
];

function MeterCards({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const [meters, setMeters] = React.useState<
    { metric: string; label: string; check: CheckQuotaResponse }[] | null
  >(null);

  React.useEffect(() => {
    let cancelled = false;
    setMeters(null);
    void Promise.all(
      METER_METRICS.map((m) => wrap(() => client.metering.checkQuota(orgId, { metric: m.metric }))),
    ).then((results) => {
      if (cancelled) return;
      const out: { metric: string; label: string; check: CheckQuotaResponse }[] = [];
      results.forEach((r, i) => {
        const def = METER_METRICS[i]!;
        if (r.ok && (r.data.limit > 0 || r.data.used > 0)) out.push({ ...def, check: r.data });
      });
      setMeters(out);
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);

  if (meters === null) {
    return (
      <div className="mt-[30px] grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[134px] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (meters.length === 0) return null;
  return (
    <div className="mt-[30px] grid grid-cols-1 gap-3.5 sm:grid-cols-3">
      {meters.map((m) => (
        <MeterCard key={m.metric} label={m.label} check={m.check} />
      ))}
    </div>
  );
}

function MeterCard({ label, check }: { label: string; check: CheckQuotaResponse }) {
  const hasLimit = check.limit > 0;
  const pct = hasLimit ? Math.round((check.used / check.limit) * 100) : 0;
  const tone: Tone | undefined = !hasLimit
    ? undefined
    : pct >= 100
      ? "error"
      : pct > 80
        ? "warning"
        : undefined;
  return (
    <div className="rounded-xl border bg-card px-[22px] py-5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-semibold">{label}</span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground/80">
          {hasLimit ? `of ${formatQuantity(check.limit)}` : "no limit"}
        </span>
      </div>
      <div className="mt-2.5 font-serif text-[30px] font-medium leading-[1.15]">
        {formatQuantity(check.used)}
      </div>
      <MeterBar percent={pct} {...(tone ? { tone } : {})} className="mt-3.5" />
      <div className="mt-2 text-[11.5px] text-muted-foreground">
        {hasLimit
          ? `${pct}% of limit ${formatPeriod(check.period)}`
          : "no quota configured for this metric"}
      </div>
    </div>
  );
}

// --- State-plane usage (OV9) -------------------------------------------------
// The org's state footprint: the live STOCK (what's stored right now, from the
// object/log indexes) as the headline, plus the FLOW (volume pushed in the
// page-selected window, from the per-push metering metrics) as the detail.

function StatePlaneUsage({ orgId, range }: { orgId: string; range: RangePreset }) {
  const { client } = useSession();
  const [stored, setStored] = React.useState<{
    objects: { count: number; bytes: number };
    logs: { count: number; bytes: number };
  } | null>(null);
  const [storedError, setStoredError] = React.useState<{ code: string; message: string } | null>(null);
  const [flow, setFlow] = React.useState<{ objectCount: number; objectBytes: number; logBytes: number } | null>(null);
  const [flowError, setFlowError] = React.useState<{ code: string; message: string } | null>(null);
  const [flowLoading, setFlowLoading] = React.useState(true);

  // STOCK — current footprint, window-independent. Its failure stays scoped to
  // the "Stored now" section; the FLOW detail still renders.
  React.useEffect(() => {
    let cancelled = false;
    setStoredError(null);
    void wrap(() => client.state.getStateStorage(orgId)).then((r) => {
      if (cancelled) return;
      if (r.ok) setStored(r.data.usage);
      else setStoredError({ code: r.error.code, message: r.error.message });
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId]);

  // FLOW — volume pushed in the selected window (three per-push metrics). A
  // failure of any of the three surfaces in the "Pushed" section, not as a 0.
  React.useEffect(() => {
    let cancelled = false;
    setFlowLoading(true);
    setFlowError(null);
    const q = (metric: string) =>
      wrap(() => client.metering.getUsageSummary(orgId, buildUsageQuery({ metric, bucketType: "day", range })));
    void Promise.all([
      q(STATE_USAGE_METRICS.objectCount),
      q(STATE_USAGE_METRICS.objectBytes),
      q(STATE_USAGE_METRICS.logBytes),
    ]).then(([count, bytes, logs]) => {
      if (cancelled) return;
      const failed = [count, bytes, logs].find((r) => !r.ok);
      if (failed && !failed.ok) {
        setFlowError({ code: failed.error.code, message: failed.error.message });
      } else {
        setFlow({
          objectCount: count.ok ? count.data.totalQuantity : 0,
          objectBytes: bytes.ok ? bytes.data.totalQuantity : 0,
          logBytes: logs.ok ? logs.data.totalQuantity : 0,
        });
      }
      setFlowLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId, range]);

  const rangeLabel = (RANGE_PRESETS.find((p) => p.value === range) ?? RANGE_PRESETS[2]!).label.toLowerCase();

  return (
    <div className="mt-3.5 rounded-xl border bg-card px-6 py-5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className="text-[13.5px] font-semibold">State plane</span>
        <span className="text-[11.5px] text-muted-foreground/80">
          objects and logs the platform stores for this workspace
        </span>
      </div>
      <UsageSection label="Stored now" error={storedError} className="mt-4">
        {stored ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StateTile label="Objects" value={formatQuantity(stored.objects.count)} />
            <StateTile label="Object storage" value={formatBytes(stored.objects.bytes)} />
            <StateTile label="Log storage" value={formatBytes(stored.logs.bytes)} />
          </div>
        ) : (
          <TileSkeletons />
        )}
      </UsageSection>
      <UsageSection label={`Pushed · ${rangeLabel}`} error={flowError} className="mt-4">
        {flowLoading || !flow ? (
          <TileSkeletons />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StateTile label="Objects pushed" value={formatQuantity(flow.objectCount)} />
            <StateTile label="Object volume" value={formatBytes(flow.objectBytes)} />
            <StateTile label="Log volume" value={formatBytes(flow.logBytes)} />
          </div>
        )}
      </UsageSection>
    </div>
  );
}

/** Bordered inner tile: kicker label + serif 21px value. */
function StateTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-border/70 px-4 py-[13px]">
      <Kicker>{label}</Kicker>
      <div className="mt-[5px] font-serif text-[21px] font-medium leading-tight">{value}</div>
    </div>
  );
}

function TileSkeletons() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-[66px] w-full rounded-[10px]" />
      ))}
    </div>
  );
}

/** One labelled section of the State-plane card; its error stays scoped here. */
function UsageSection({
  label,
  error,
  className,
  children,
}: {
  label: string;
  error: { code: string; message: string } | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Kicker className="mb-2.5">{label}</Kicker>
      {error ? <InlineError error={error} /> : children}
    </div>
  );
}

/** Quiet single-line error surface for a failed section fetch. */
function InlineError({ error }: { error: { code: string; message: string } }) {
  return (
    <div className="rounded-[10px] border border-destructive/30 bg-destructive-soft px-4 py-3 text-[12.5px]">
      <span className="font-medium text-destructive">{error.code}</span>{" "}
      <span className="text-muted-foreground">{error.message}</span>
    </div>
  );
}

// --- Usage summary ----------------------------------------------------------

function UsageSummary({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const [draft, setDraft] = React.useState<UsageFormValues>(DEFAULT_USAGE_FORM);
  const [applied, setApplied] = React.useState<UsageFormValues | null>(null);
  const [data, setData] = React.useState<GetUsageSummaryResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

  React.useEffect(() => {
    if (!applied || !canQueryUsage(applied)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void wrap(() => client.metering.getUsageSummary(orgId, buildUsageQuery(applied))).then((r) => {
      if (cancelled) return;
      if (r.ok) setData(r.data);
      else setError({ code: r.error.code, message: r.error.message });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [client, orgId, applied]);

  const rollups = data ? sortRollups(data.rollups) : [];
  const bars = usageBarPercents(rollups);

  return (
    <div className="mt-[30px]">
      <Kicker className="mb-2.5">Consumption</Kicker>
      <div className="rounded-xl border bg-card px-6 py-5">
        <p className="text-[12.5px] text-muted-foreground">
          Pick a metric and window to summarize recorded usage. Metrics are product-defined keys
          (e.g.{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">api_requests</code>).
        </p>
        <form
          className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(draft);
          }}
        >
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="metric" className="text-xs text-muted-foreground">Metric</Label>
            <Input
              id="metric"
              list="metric-suggestions"
              placeholder="api_requests"
              value={draft.metric}
              onChange={(e) => setDraft((d) => ({ ...d, metric: e.target.value }))}
            />
            <datalist id="metric-suggestions">
              {METRIC_SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Bucket</Label>
            <Select
              value={draft.bucketType}
              onValueChange={(v) => setDraft((d) => ({ ...d, bucketType: v as BucketType }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="day">Daily</SelectItem>
                <SelectItem value="hour">Hourly</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Range</Label>
            <Select
              value={draft.range}
              onValueChange={(v) => setDraft((d) => ({ ...d, range: v as RangePreset }))}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGE_PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-4">
            <Button type="submit" variant="outline" disabled={!canQueryUsage(draft)}>
              View usage
            </Button>
          </div>
        </form>

        {!applied ? (
          <QuietEmpty
            className="mt-4"
            title="Choose a metric"
            description="Enter a metric key and window above to see consumption over time."
          />
        ) : loading ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : error ? (
          <div className="mt-4">
            <InlineError error={error} />
          </div>
        ) : data && rollups.length > 0 ? (
          <div className="mt-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StateTile label="Total" value={formatQuantity(data.totalQuantity)} />
              <StateTile label="Records" value={formatQuantity(data.totalRecords)} />
              <StateTile label="Buckets" value={String(rollups.length)} />
            </div>
            <div className="mt-4 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Bucket</TableHead>
                    <TableHead className="w-1/2">Quantity</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rollups.map((r, i) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatBucket(r.bucketStart, r.bucketType)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <MeterBar percent={bars[i] ?? 0} className="min-w-[80px] flex-1" />
                          <span className="w-16 shrink-0 text-right font-mono text-[11.5px]">
                            {formatQuantity(r.quantity)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[11.5px] text-muted-foreground">
                        {r.recordCount}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : (
          <QuietEmpty
            className="mt-4"
            title="No usage recorded"
            description="No usage was recorded for this metric in the selected window."
          />
        )}
      </div>
    </div>
  );
}

/** Quiet centered empty state: 13.5px title + 12.5px muted sub. */
function QuietEmpty({
  title,
  description,
  className,
}: {
  title: string;
  description: string;
  className?: string;
}) {
  return (
    <div className={cn("rounded-[10px] border border-dashed px-6 py-9 text-center", className)}>
      <div className="text-[13.5px] text-secondary-foreground">{title}</div>
      <div className="mt-1 text-[12.5px] text-muted-foreground/80">{description}</div>
    </div>
  );
}

// --- Quota violations -------------------------------------------------------

function QuotaViolations({ orgId, periodLabel }: { orgId: string; periodLabel: string }) {
  const { client } = useSession();
  const [metricDraft, setMetricDraft] = React.useState("");
  const [metricFilter, setMetricFilter] = React.useState("");
  const [state, setState] = React.useState<ViolationsState>(EMPTY_VIOLATIONS);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

  const loadFirst = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const r = await wrap(() =>
      client.metering.listQuotaViolations(orgId, buildViolationsQuery(metricFilter)),
    );
    if (r.ok) setState(appendViolationsPage(EMPTY_VIOLATIONS, r.data, true));
    else {
      setError({ code: r.error.code, message: r.error.message });
      setState(EMPTY_VIOLATIONS);
    }
    setLoading(false);
  }, [client, orgId, metricFilter]);

  React.useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const loadMore = React.useCallback(async () => {
    if (state.cursor === null) return;
    setLoadingMore(true);
    const r = await wrap(() =>
      client.metering.listQuotaViolations(orgId, buildViolationsQuery(metricFilter, state.cursor)),
    );
    if (r.ok) setState((prev) => appendViolationsPage(prev, r.data));
    else setError({ code: r.error.code, message: r.error.message });
    setLoadingMore(false);
  }, [client, orgId, metricFilter, state.cursor]);

  return (
    <div className="mt-[30px]">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Kicker>Quota violations</Kicker>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setMetricFilter(metricDraft);
          }}
        >
          <label htmlFor="vmetric" className="sr-only">Filter by metric</label>
          <Input
            id="vmetric"
            placeholder="Filter by metric"
            value={metricDraft}
            onChange={(e) => setMetricDraft(e.target.value)}
            className="h-8 w-40 text-xs"
          />
          <Button type="submit" variant="outline" size="sm">Apply</Button>
          {metricFilter ? (
            <QuietLink
              onClick={() => {
                setMetricDraft("");
                setMetricFilter("");
              }}
            >
              Reset
            </QuietLink>
          ) : null}
        </form>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        {loading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : error ? (
          <div className="px-6 py-5 text-[12.5px]">
            <span className="font-medium text-destructive">{error.code}</span>{" "}
            <span className="text-muted-foreground">{error.message}</span>
          </div>
        ) : state.violations.length === 0 ? (
          <div className="px-6 py-9 text-center">
            <div className="text-[13.5px] text-secondary-foreground">
              {metricFilter
                ? `No violations recorded for “${metricFilter}”.`
                : `Nothing hit a limit in the ${periodLabel.toLowerCase()}.`}
            </div>
            <div className="mt-1 text-[12.5px] text-muted-foreground/80">
              When a metric crosses its quota, the violation appears here with the exact request
              that was refused.
            </div>
          </div>
        ) : (
          <>
            {state.violations.map((v) => {
              const open = isViolationOpen(v);
              const pct = overagePercent(v);
              return (
                <div
                  key={v.id}
                  className={cn(
                    "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/50 px-5 py-3 first:border-t-0",
                    open && "bg-destructive-wash",
                  )}
                >
                  <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                    {formatTimestamp(v.violatedAt)}
                  </span>
                  <span className="min-w-0 flex-1 text-[13px]">
                    <span className="font-mono text-[12.5px] font-medium">{v.metric}</span>
                    <span className="text-muted-foreground">
                      {" "}· {formatQuantity(v.actualValue)} of {formatQuantity(v.limitValue)}{" "}
                      {formatPeriod(v.period)}
                      {pct !== null ? ` · ${pct}% of limit` : ""}
                    </span>
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <Pill tone="neutral" className="text-[11px]">{v.enforcement}</Pill>
                    <Pill tone={open ? "error" : "neutral"} dot>
                      {open ? "open" : "resolved"}
                    </Pill>
                  </span>
                </div>
              );
            })}
            {hasMoreViolations(state) ? (
              <div className="flex justify-center border-t border-border/50 px-5 py-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadMore()}
                  loading={loadingMore}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
