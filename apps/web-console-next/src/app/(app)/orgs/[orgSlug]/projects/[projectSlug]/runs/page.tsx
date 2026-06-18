"use client";

// OV7 — the project runs list. The run-coordination plane's execution history
// for a project, newest first, filterable by status / environment, with manual
// keyset "Load more" pagination. Mirrors the org catalog browser; project-scoped
// (resolves projectSlug → projectId via the projects list, like the CLI page).

import * as React from "react";
import { useParams } from "next/navigation";
import { Play } from "lucide-react";
import type { Run, RunStatus, StateCursor } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

const STATUS_OPTIONS: RunStatus[] = ["pending", "running", "succeeded", "failed", "canceled"];

/** Map a run status to a Badge tone. */
function statusVariant(status: RunStatus): "success" | "destructive" | "warning" | "secondary" {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
      return "destructive";
    case "running":
    case "pending":
      return "warning";
    case "canceled":
      return "secondary";
  }
}

/** Debounce a fast-changing text value before it drives refetches. */
function useDebounced<T>(value: T, delayMs = 400): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export default function RunsPage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return <OrgScope slug={orgSlug}>{(org) => <Inner orgId={org.id} projectSlug={projectSlug} />}</OrgScope>;
}

function Inner({ orgId, projectSlug }: { orgId: string; projectSlug: string }) {
  const { client } = useSession();

  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );
  const projectId = project?.id ?? null;

  const [status, setStatus] = React.useState("all");
  const [envInput, setEnvInput] = React.useState("");
  const environment = useDebounced(envInput);

  const applied = React.useMemo(() => {
    const a: { status?: string; environment?: string } = {};
    if (status !== "all") a.status = status;
    if (environment.trim()) a.environment = environment.trim();
    return a;
  }, [status, environment]);
  const appliedKey = JSON.stringify(applied);

  const [runs, setRuns] = React.useState<Run[]>([]);
  const [cursor, setCursor] = React.useState<StateCursor | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<{ code: string; message: string } | null>(null);

  const loadFirstPage = React.useCallback(async () => {
    if (!projectId) return; // wait for the project to resolve
    setLoading(true);
    setError(null);
    const res = await wrap(() => client.state.listRuns(orgId, projectId, applied));
    if (res.ok) {
      setRuns(res.data.runs);
      setCursor(res.data.nextCursor);
    } else {
      setError({ code: res.error.code, message: res.error.message });
      setRuns([]);
      setCursor(null);
    }
    setLoading(false);
  }, [client, orgId, projectId, appliedKey]);

  React.useEffect(() => {
    void loadFirstPage();
  }, [loadFirstPage]);

  const loadMore = React.useCallback(async () => {
    if (cursor === null || loadingMore || !projectId) return;
    setLoadingMore(true);
    const res = await wrap(() =>
      client.state.listRuns(orgId, projectId, { ...applied, cursor: `${cursor.createdAt}|${cursor.id}` }),
    );
    if (res.ok) {
      setRuns((prev) => [...prev, ...res.data.runs]);
      setCursor(res.data.nextCursor);
    } else {
      setError({ code: res.error.code, message: res.error.message });
    }
    setLoadingMore(false);
  }, [client, orgId, projectId, appliedKey, cursor, loadingMore]);

  const filtersActive = applied.status !== undefined || applied.environment !== undefined;
  const clearAll = () => {
    setStatus("all");
    setEnvInput("");
  };

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Runs</h1>
        <p className="text-sm text-muted-foreground">Execution history for this project, newest first.</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={envInput}
          onChange={(e) => setEnvInput(e.target.value)}
          placeholder="Environment"
          aria-label="Environment"
          className="h-8 w-[180px] text-xs"
        />
      </div>

      {projectsList.loading || (project && loading) ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : projectsList.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{projectsList.error.code}</CardTitle>
            <CardDescription>{projectsList.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !project ? (
        <EmptyState icon={Play} title="Project not found" description={`No project "${projectSlug}" in this organization.`} />
      ) : error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{error.code}</CardTitle>
            <CardDescription>{error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={Play}
          title={filtersActive ? "No matching runs" : "No runs yet"}
          description={
            filtersActive
              ? "No runs match the current filters. Clear a filter to widen the view."
              : "Runs appear here as the CLI or CI executes plans against this project."
          }
          {...(filtersActive ? { primaryAction: { label: "Clear filters", onClick: clearAll } } : {})}
        />
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 md:hidden">
            {runs.map((r) => (
              <Card key={r.runId} className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="break-all font-mono text-xs">{r.runId}</div>
                    <div className="text-[11px] text-muted-foreground">{new Date(r.createdAt).toLocaleString()}</div>
                  </div>
                  <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  {r.environment ? <span>env: {r.environment}</span> : null}
                  {r.git.commit ? <span className="font-mono">{r.git.commit.slice(0, 7)}</span> : null}
                  <span>
                    {r.jobCounts.succeeded}✓ {r.jobCounts.failed}✗ {r.jobCounts.running + r.jobCounts.queued}⋯
                  </span>
                </div>
              </Card>
            ))}
          </div>

          {/* Desktop: table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>Jobs</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <TableRow key={r.runId}>
                    <TableCell className="font-mono text-xs">{r.runId}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.environment ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {r.git.commit ? r.git.commit.slice(0, 7) : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.jobCounts.succeeded}✓ {r.jobCounts.failed}✗ {r.jobCounts.running + r.jobCounts.queued}⋯
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {cursor !== null ? (
            <div className="flex justify-center pt-1">
              <Button type="button" variant="outline" onClick={() => void loadMore()} loading={loadingMore}>
                Load more
              </Button>
            </div>
          ) : (
            <p className="pt-1 text-center text-[11px] text-muted-foreground">End of the run history for these filters.</p>
          )}
        </>
      )}
    </div>
  );
}
