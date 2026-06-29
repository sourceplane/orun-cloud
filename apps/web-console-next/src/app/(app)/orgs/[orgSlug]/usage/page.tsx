"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Gauge, AlertTriangle, BarChart3, Database } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/ui/empty-state";
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
import { wrap } from "@/lib/api";
import { formatTimestamp } from "@/lib/format";
import { useSession } from "@/lib/session";
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
import type { GetUsageSummaryResponse } from "@saas/contracts/metering";

export default function UsagePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Usage &amp; quota</h1>
        <p className="text-sm text-muted-foreground">
          Metered consumption and quota status for this workspace.
        </p>
      </header>
      <StatePlaneUsage orgId={orgId} />
      <UsageSummary orgId={orgId} />
      <QuotaViolations orgId={orgId} />
    </div>
  );
}

// --- State-plane usage (OV9) -------------------------------------------------
// The org's state footprint: the live STOCK (what's stored right now, from the
// object/log indexes) as the headline, plus the FLOW (volume pushed in a
// selectable window, from the per-push metering metrics) as the windowed detail.

function StatePlaneUsage({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const [range, setRange] = React.useState<RangePreset>("30d");
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
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" /> State plane
          </CardTitle>
          <CardDescription>What this workspace stores in remote state, and recent push volume.</CardDescription>
        </div>
        <Select value={range} onValueChange={(v) => setRange(v as RangePreset)}>
          <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {RANGE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-5">
        <UsageSection label="Stored now" error={storedError}>
          {stored ? (
            <div className="flex flex-wrap gap-8">
              <Metric label="Objects" value={formatQuantity(stored.objects.count)} />
              <Metric label="Object storage" value={formatBytes(stored.objects.bytes)} />
              <Metric label="Log storage" value={formatBytes(stored.logs.bytes)} />
            </div>
          ) : (
            <MetricSkeletons />
          )}
        </UsageSection>
        <UsageSection label={`Pushed · ${rangeLabel}`} error={flowError}>
          {flowLoading || !flow ? (
            <MetricSkeletons />
          ) : (
            <div className="flex flex-wrap gap-8">
              <Metric label="Objects pushed" value={formatQuantity(flow.objectCount)} />
              <Metric label="Object volume" value={formatBytes(flow.objectBytes)} />
              <Metric label="Log volume" value={formatBytes(flow.logBytes)} />
            </div>
          )}
        </UsageSection>
      </CardContent>
    </Card>
  );
}

function MetricSkeletons() {
  return (
    <div className="flex flex-wrap gap-8">
      {Array.from({ length: 3 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-28" />
      ))}
    </div>
  );
}

/** One labelled section of the State-plane card; its error stays scoped here. */
function UsageSection({
  label,
  error,
  children,
}: {
  label: string;
  error: { code: string; message: string } | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <span className="font-medium text-destructive">{error.code}</span>{" "}
          <span className="text-muted-foreground">{error.message}</span>
        </div>
      ) : (
        children
      )}
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" /> Consumption
        </CardTitle>
        <CardDescription>
          Pick a metric and window to summarize recorded usage. Metrics are
          product-defined keys (e.g. <code>api_requests</code>).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(draft);
          }}
        >
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="metric" className="text-xs">Metric</Label>
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
            <Label className="text-xs">Bucket</Label>
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
            <Label className="text-xs">Range</Label>
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
          <EmptyState
            icon={Gauge}
            title="Choose a metric"
            description="Enter a metric key and window above to see consumption over time."
          />
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
            <div className="font-medium text-destructive">{error.code}</div>
            <div className="text-sm text-muted-foreground">{error.message}</div>
          </div>
        ) : data && rollups.length > 0 ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-6">
              <Metric label="Total" value={formatQuantity(data.totalQuantity)} />
              <Metric label="Records" value={formatQuantity(data.totalRecords)} />
              <Metric label="Buckets" value={String(rollups.length)} />
            </div>
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
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded-full bg-muted">
                          <div
                            className="h-2 rounded-full bg-primary"
                            style={{ width: `${bars[i] ?? 0}%` }}
                          />
                        </div>
                        <span className="w-16 text-right font-mono text-xs">
                          {formatQuantity(r.quantity)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">
                      {r.recordCount}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState
            icon={Gauge}
            title="No usage recorded"
            description="No usage was recorded for this metric in the selected window."
          />
        )}
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

// --- Quota violations -------------------------------------------------------

function QuotaViolations({ orgId }: { orgId: string }) {
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
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" /> Quota violations
        </CardTitle>
        <CardDescription>Recorded breaches of a configured quota limit.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setMetricFilter(metricDraft);
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="vmetric" className="text-xs">Filter by metric</Label>
            <Input
              id="vmetric"
              placeholder="all metrics"
              value={metricDraft}
              onChange={(e) => setMetricDraft(e.target.value)}
            />
          </div>
          <Button type="submit" variant="outline">Apply</Button>
          {metricFilter ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setMetricDraft("");
                setMetricFilter("");
              }}
            >
              Reset
            </Button>
          ) : null}
        </form>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
            <div className="font-medium text-destructive">{error.code}</div>
            <div className="text-sm text-muted-foreground">{error.message}</div>
          </div>
        ) : state.violations.length === 0 ? (
          <EmptyState
            icon={AlertTriangle}
            title="No quota violations"
            description={
              metricFilter
                ? `No violations recorded for “${metricFilter}”.`
                : "Nothing has exceeded a configured quota. You're within limits."
            }
          />
        ) : (
          <div className="space-y-2">
            {state.violations.map((v) => {
              const pct = overagePercent(v);
              return (
                <div key={v.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">{v.metric}</span>
                      <Badge variant={isViolationOpen(v) ? "destructive" : "secondary"} className="text-[10px]">
                        {isViolationOpen(v) ? "open" : "resolved"}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">{v.enforcement}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {formatQuantity(v.actualValue)} / {formatQuantity(v.limitValue)} {formatPeriod(v.period)}
                      {pct !== null ? ` · ${pct}% of limit` : ""}
                    </div>
                  </div>
                  <div className="whitespace-nowrap text-[11px] text-muted-foreground">
                    {formatTimestamp(v.violatedAt)}
                  </div>
                </div>
              );
            })}
            {hasMoreViolations(state) ? (
              <div className="flex justify-center pt-2">
                <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
