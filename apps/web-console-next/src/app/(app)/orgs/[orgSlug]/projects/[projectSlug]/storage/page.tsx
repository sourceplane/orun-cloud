"use client";

// OV9 — the project Storage panel. Surfaces the object-GC reachability report
// (how much stored data no live pointer reaches) and a SAFE reclamation control:
// a dry-run preview is always available; the explicit, confirmed "Reclaim" is
// only honored by the state plane when the per-environment master switch is on
// AND the reachability walk was complete (never when capped). Project-scoped —
// resolves projectSlug → projectId via the projects list, like the Runs/CLI pages.

import * as React from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, Eye, Trash2 } from "lucide-react";
import type { StateGcCollectResult } from "@saas/contracts/state";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/toast";
import { formatBytes } from "@/components/usage/usage";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export default function StoragePage() {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";
  return <OrgScope slug={orgSlug}>{(org) => <Inner orgId={org.id} projectSlug={projectSlug} />}</OrgScope>;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** A non-success collect outcome rendered as a banner — tone + one sentence. */
function outcomeBanner(result: StateGcCollectResult, requestedDelete: boolean): { tone: string; text: string } | null {
  if (result.capped) {
    return {
      tone: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
      text: "Refused: the reachability walk was capped, so deletion can’t be proven safe. Nothing was deleted — the project has more objects than one pass can enumerate.",
    };
  }
  if (requestedDelete && result.dryRun) {
    return {
      tone: "border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-200",
      text: "Reclamation is disabled in this environment, so this was a dry run — nothing was deleted. An operator must set STATE_GC_COLLECT_ENABLED to allow deletion.",
    };
  }
  return null;
}

function Inner({ orgId, projectSlug }: { orgId: string; projectSlug: string }) {
  const { client } = useSession();
  const { toast } = useToast();

  const projectsList = useApiQuery(qk.projects(orgId), () =>
    wrap(async () => (await client.projects.list(orgId)).projects),
  );
  const project = React.useMemo(
    () => projectsList.data?.find((p) => p.slug === projectSlug) ?? null,
    [projectsList.data, projectSlug],
  );
  const projectId = project?.id ?? null;

  const report = useApiQuery(
    qk.gcReport(orgId, projectId ?? "pending"),
    () => wrap(async () => (await client.state.getGcReport(orgId, projectId!)).report),
    { enabled: !!projectId },
  );

  const [graceDays, setGraceDays] = React.useState(7);
  const [busy, setBusy] = React.useState<null | "preview" | "reclaim">(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [collect, setCollect] = React.useState<{ result: StateGcCollectResult; requestedDelete: boolean } | null>(null);

  const runCollect = React.useCallback(
    async (dryRun: boolean) => {
      if (!projectId) return;
      setBusy(dryRun ? "preview" : "reclaim");
      const res = await wrap(async () => (await client.state.collectGc(orgId, projectId, { dryRun, graceDays })).result);
      setBusy(null);
      if (!res.ok) {
        toast({ kind: "error", title: "Collection failed", description: res.error.message });
        return;
      }
      setCollect({ result: res.data, requestedDelete: !dryRun });
      if (res.data.deletedObjects > 0) {
        toast({
          kind: "success",
          title: "Storage reclaimed",
          description: `${res.data.deletedObjects.toLocaleString()} objects (${formatBytes(res.data.deletedBytes)}) deleted.`,
        });
        report.reload(); // the report's reclaimable figure just dropped
      }
    },
    [client, orgId, projectId, graceDays, toast, report],
  );

  if (projectsList.loading || (!!projectId && report.loading)) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (projectsList.data && !project) {
    return <EmptyState icon={AlertTriangle} title="Repo not found" description="No repo matches this URL." />;
  }
  if (report.error) {
    // The GC report is best-effort (needs the R2 binding + DB); a dormant env 503s.
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Storage report unavailable"
        description={
          report.error.code === "internal_error"
            ? "Object storage isn’t available in this environment yet."
            : report.error.message
        }
      />
    );
  }

  const r = report.data;
  const banner = collect ? outcomeBanner(collect.result, collect.requestedDelete) : null;

  return (
    <div className="space-y-5">
      <p className="max-w-[560px] text-[13px] leading-normal text-muted-foreground">
        Object storage for this project — what’s reachable from live pointers, and what garbage
        collection can reclaim.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Reachability report
            {r?.capped ? <Badge variant="warning">Capped — upper bound</Badge> : null}
          </CardTitle>
          <CardDescription>
            Reachable objects are kept by a current ref, a retained catalog head, or a run plan. The rest is reclaimable.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {r ? (
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
              <Metric label="Total objects" value={r.totalObjects.toLocaleString()} hint={formatBytes(r.totalBytes)} />
              <Metric label="Reachable" value={r.reachableObjects.toLocaleString()} />
              <Metric label="Unreachable" value={r.unreachableObjects.toLocaleString()} />
              <Metric label="Reclaimable" value={formatBytes(r.reclaimableBytes)} hint="no live pointer reaches it" />
            </div>
          ) : null}
          {r?.capped ? (
            <p className="mt-4 text-xs text-amber-700 dark:text-amber-300">
              The walk hit its visit cap, so the reclaimable figure is an upper bound — reclamation is refused until a full
              pass is possible.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Reclaim storage</CardTitle>
          <CardDescription>
            Preview the unreachable objects eligible for deletion, then reclaim them. Deletion is off by default and only
            ever removes objects older than the grace window.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="graceDays">Grace window (days)</Label>
              <Input
                id="graceDays"
                type="number"
                min={0}
                max={3650}
                value={graceDays}
                onChange={(e) => setGraceDays(Math.max(0, Math.min(3650, Number(e.target.value) || 0)))}
                className="w-32"
              />
            </div>
            <Button variant="outline" onClick={() => void runCollect(true)} disabled={busy !== null || !projectId}>
              <Eye className="mr-2 h-4 w-4" />
              {busy === "preview" ? "Previewing…" : "Preview (dry run)"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmOpen(true)}
              disabled={busy !== null || !projectId || !!r?.capped}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Reclaim now
            </Button>
          </div>

          {banner ? <div className={`rounded-md border px-3 py-2 text-sm ${banner.tone}`}>{banner.text}</div> : null}

          {collect && !banner ? (
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
              {collect.result.deletedObjects > 0 ? (
                <span>
                  Reclaimed <strong>{collect.result.deletedObjects.toLocaleString()}</strong> objects (
                  {formatBytes(collect.result.deletedBytes)}).
                </span>
              ) : (
                <span>
                  Dry run — <strong>{collect.result.candidateObjects.toLocaleString()}</strong> objects (
                  {formatBytes(collect.result.candidateBytes)}) are eligible and would be reclaimed. Nothing was deleted.
                </span>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Reclaim unreachable objects?"
        description={`This permanently deletes unreachable objects older than ${graceDays} day${graceDays === 1 ? "" : "s"} from this project's storage. It is refused if the reachability scan is incomplete, and runs as a dry run unless deletion is enabled for this environment.`}
        resourceName={projectSlug}
        confirmLabel="Reclaim"
        onConfirm={() => runCollect(false)}
      />
    </div>
  );
}
