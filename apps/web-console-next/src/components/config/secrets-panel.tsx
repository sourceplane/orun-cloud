"use client";

import * as React from "react";
import { z } from "zod";
import {
  Lock,
  History,
  Waypoints,
  Eye,
  MoreHorizontal,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { useParams } from "next/navigation";
import type { ConfigScope } from "@saas/sdk";
import type { PublicSecretMetadata, PublicSecretVersion, PublicSecretSync } from "@saas/contracts/config";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { ZodForm } from "@/components/ui/zod-form";
import { AttentionBanner, StatusDot } from "@/components/ui/northwind";
import { cn } from "@/lib/cn";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { ListSkeleton, LoadError } from "./config-shared";
import { NewSecretContext } from "./config-surface";
import { rotationStatus, revealGuard, syncStatusView, scopeChainChips } from "./secrets-view";

const secretSchema = z.object({
  secretKey: z.string().min(1).max(128),
  value: z.string().min(1),
  displayName: z.string().max(128).optional(),
});
const rotateSchema = z.object({ value: z.string().min(1) });

const GRID_COLS = "minmax(220px,1.5fr) minmax(150px,1fr) 150px 130px 92px 44px";

/**
 * The Secrets console surface (saas-secret-manager SM1/SM5/SEC7). Write-only on
 * the wire: list reads carry metadata only, and NO value is ever rendered except
 * transiently inside the break-glass reveal dialog. At environment scope the
 * chain read (`chain=true`) surfaces each key's serving rung + a Locked badge.
 */
export function SecretsPanel({ scope, scopeKey }: { scope: ConfigScope; scopeKey: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? "";
  const isEnv = scope.kind === "environment";

  // Environment scope reads the whole chain; other scopes read the exact scope.
  const secrets = useApiQuery(qk.configSecrets(scopeKey), () =>
    wrap(async () =>
      isEnv
        ? (await client.config.listSecretChain(scope)).secrets
        : (await client.config.listSecretMetadata(scope)).secrets,
    ),
  );

  const [createOpen, setCreateOpen] = React.useState(false);
  const [rotating, setRotating] = React.useState<PublicSecretMetadata | null>(null);
  const [revoking, setRevoking] = React.useState<PublicSecretMetadata | null>(null);
  const [versionsFor, setVersionsFor] = React.useState<PublicSecretMetadata | null>(null);
  const [syncsFor, setSyncsFor] = React.useState<PublicSecretMetadata | null>(null);
  const [revealFor, setRevealFor] = React.useState<PublicSecretMetadata | null>(null);

  // Let the page-level "New secret" button (in the PageHeader) drive this
  // panel's create dialog. No-op when the panel renders outside the console.
  const newSecretRef = React.useContext(NewSecretContext);
  React.useEffect(() => {
    if (!newSecretRef) return;
    newSecretRef.current = () => setCreateOpen(true);
    return () => {
      newSecretRef.current = null;
    };
  }, [newSecretRef]);

  const now = React.useMemo(() => new Date(), [secrets.data]);

  const revoke = async (secretId: string) => {
    const r = await wrap(() => client.config.revokeSecret(scope, secretId));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Secret revoked" });
    secrets.reload();
  };

  // The most overdue secret drives the attention banner (Rotate now).
  const overdue = React.useMemo(() => {
    if (!secrets.data) return null;
    let worst: { secret: PublicSecretMetadata; overBy: number } | null = null;
    for (const s of secrets.data) {
      const rot = rotationStatus(s, now);
      if (rot.due && rot.overdueByDays !== null) {
        if (!worst || rot.overdueByDays > worst.overBy) worst = { secret: s, overBy: rot.overdueByDays };
      }
    }
    return worst;
  }, [secrets.data, now]);

  return (
    <div className="space-y-3.5">
      <div className="flex items-center justify-end gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={`/orgs/${orgSlug}/settings/audit?subjectKind=secret`}>Secret activity</a>
        </Button>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          New secret
        </Button>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create secret</DialogTitle>
            <DialogDescription>
              The value is encrypted before storage and never shown again — keep your own copy.
            </DialogDescription>
          </DialogHeader>
          <ZodForm
            schema={secretSchema}
            defaultValues={{ secretKey: "", value: "", displayName: "" }}
            fields={[
              { name: "secretKey", label: "Key", placeholder: "stripe_api_key" },
              { name: "value", label: "Value", type: "password", autoComplete: "off" },
              { name: "displayName", label: "Display name", placeholder: "Optional" },
            ]}
            submitLabel="Create secret"
            cancel={{ label: "Cancel", onClick: () => setCreateOpen(false) }}
            onSubmit={async (v) => {
              const r = await wrap(() =>
                client.config.createSecretMetadata(scope, {
                  secretKey: v.secretKey,
                  value: v.value,
                  displayName: v.displayName || null,
                }),
              );
              if (!r.ok) {
                toast({ kind: "error", title: "Create failed", description: r.error.message });
                return;
              }
              setCreateOpen(false);
              toast({ kind: "success", title: "Secret stored", description: "The value is encrypted and not retrievable." });
              secrets.reload();
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={rotating !== null} onOpenChange={(o) => !o && setRotating(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate secret</DialogTitle>
            <DialogDescription className="font-mono text-xs">{rotating?.secretKey}</DialogDescription>
          </DialogHeader>
          {rotating ? (
            <ZodForm
              schema={rotateSchema}
              defaultValues={{ value: "" }}
              fields={[{ name: "value", label: "New value", type: "password", autoComplete: "off" }]}
              submitLabel="Rotate"
              cancel={{ label: "Cancel", onClick: () => setRotating(null) }}
              onSubmit={async (v) => {
                const r = await wrap(() => client.config.rotateSecret(scope, rotating.id, { value: v.value }));
                if (!r.ok) {
                  toast({ kind: "error", title: "Rotate failed", description: r.error.message });
                  return;
                }
                setRotating(null);
                toast({ kind: "success", title: "Secret rotated" });
                secrets.reload();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Revoke secret"
        description="Consumers reading this secret stop resolving it immediately. This cannot be undone."
        resourceName={revoking?.secretKey}
        confirmLabel="Revoke secret"
        onConfirm={() => (revoking ? revoke(revoking.id) : undefined)}
      />

      <VersionsSheet scope={scope} secret={versionsFor} onClose={() => setVersionsFor(null)} />
      <SyncsSheet scope={scope} secret={syncsFor} onClose={() => setSyncsFor(null)} />
      <RevealDialog scope={scope} secret={revealFor} onClose={() => setRevealFor(null)} />

      {secrets.loading ? (
        <ListSkeleton />
      ) : secrets.error ? (
        <LoadError title="Failed to load secrets" message={secrets.error.message} />
      ) : !secrets.data || secrets.data.length === 0 ? (
        <EmptyState
          icon={Lock}
          title="No secrets yet"
          description="Store provider keys and tokens encrypted at this scope, or bring an existing set in with orun secrets import. Read them from your product at runtime — values never leave the vault."
          primaryAction={{ label: "New secret", onClick: () => setCreateOpen(true) }}
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="overflow-x-auto">
              {/* Header */}
              <div
                className="grid min-w-[720px] items-center gap-3 border-b border-border/70 px-[22px] py-[10px] text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/80"
                style={{ gridTemplateColumns: GRID_COLS }}
              >
                <span>Secret</span>
                <span>Scope chain</span>
                <span>Rotation</span>
                <span>Sync</span>
                <span>Updated</span>
                <span className="sr-only">Actions</span>
              </div>
              {secrets.data.map((s) => {
                const rot = rotationStatus(s, now);
                const chips = scopeChainChips(s);
                const sync = syncStatusView({ status: s.status });
                const used = s.displayName ?? (s.servesFrom ? `serves from ${s.servesFrom}` : null);
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "grid min-w-[720px] items-center gap-3 border-t border-border/50 px-[22px] py-[13px] first:border-t-0",
                      rot.due && "bg-warning-wash",
                    )}
                    style={{ gridTemplateColumns: GRID_COLS }}
                  >
                    {/* Secret */}
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[12.5px] font-semibold">{s.secretKey}</span>
                      {used ? (
                        <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground/80">{used}</span>
                      ) : null}
                    </span>

                    {/* Scope chain */}
                    <span className="flex min-w-0 flex-wrap gap-1">
                      {chips.length === 0 ? (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      ) : (
                        chips.map((c, i) => (
                          <span
                            key={`${c.label}-${i}`}
                            className={cn(
                              "rounded-[5px] px-[7px] py-[2px] text-[10.5px]",
                              c.tone === "env"
                                ? "bg-info-soft text-info"
                                : "bg-secondary text-muted-foreground",
                            )}
                          >
                            {c.label}
                            {c.override ? " ⌃" : ""}
                          </span>
                        ))
                      )}
                    </span>

                    {/* Rotation */}
                    <span
                      className={cn(
                        "text-[12px]",
                        rot.due
                          ? "font-medium text-warning"
                          : rot.hasPolicy
                            ? "text-success"
                            : "text-muted-foreground",
                      )}
                    >
                      {rot.displayLabel}
                    </span>

                    {/* Sync */}
                    <span className="inline-flex items-center gap-1.5 text-[12px]">
                      <StatusDot tone={sync.tone === "success" ? "success" : sync.tone === "warning" ? "warning" : "neutral"} />
                      <span
                        className={cn(
                          sync.tone === "success" && "text-success",
                          sync.tone === "warning" && "text-warning",
                          sync.tone !== "success" && sync.tone !== "warning" && "text-muted-foreground",
                        )}
                      >
                        {sync.label}
                      </span>
                    </span>

                    {/* Updated */}
                    <span className="text-[12px] text-muted-foreground">{rot.ageDays}d ago</span>

                    {/* Actions */}
                    <span className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" aria-label={`Actions for ${s.secretKey}`}>
                            <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setVersionsFor(s)}>
                            <History className="mr-2 h-4 w-4" /> Version history
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setSyncsFor(s)}>
                            <Waypoints className="mr-2 h-4 w-4" /> Sync provenance
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setRevealFor(s)} className="text-warning">
                            <Eye className="mr-2 h-4 w-4" /> Reveal (break-glass)
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setRotating(s)}>Rotate</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setRevoking(s)} className="text-destructive">
                            Revoke
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {overdue ? (
            <AttentionBanner
              action={
                <Button size="sm" variant="outline" onClick={() => setRotating(overdue.secret)}>
                  Rotate now
                </Button>
              }
            >
              <span className="font-mono text-[12px]">{overdue.secret.secretKey}</span> is {overdue.overBy}{" "}
              {overdue.overBy === 1 ? "day" : "days"} past its rotation policy. Reveals require a reason and are
              audit-logged.
            </AttentionBanner>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Version history (metadata only)
// ---------------------------------------------------------------------------

function VersionsSheet({
  scope,
  secret,
  onClose,
}: {
  scope: ConfigScope;
  secret: PublicSecretMetadata | null;
  onClose: () => void;
}) {
  const { client } = useSession();
  const open = secret !== null;
  const versions = useApiQuery<PublicSecretVersion[]>(
    ["configSecretVersions", secret?.id ?? "none"],
    () => wrap(async () => (await client.config.listSecretVersions(scope, secret!.id)).versions),
    { enabled: open },
  );

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[420px] max-w-[92vw]">
        <SheetHeader>
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription className="font-mono">{secret?.secretKey}</SheetDescription>
        </SheetHeader>
        <div className="mt-2 overflow-y-auto">
          {versions.loading ? (
            <ListSkeleton />
          ) : versions.error ? (
            <LoadError title="Failed to load versions" message={versions.error.message} />
          ) : !versions.data || versions.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No versions recorded.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.data.map((v) => (
                  <TableRow key={v.version}>
                    <TableCell className="font-mono text-xs">v{v.version}</TableCell>
                    <TableCell>
                      <Badge variant={v.status === "active" ? "success" : "secondary"}>{v.status}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(v.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Materialization provenance (SM5)
// ---------------------------------------------------------------------------

function SyncsSheet({
  scope,
  secret,
  onClose,
}: {
  scope: ConfigScope;
  secret: PublicSecretMetadata | null;
  onClose: () => void;
}) {
  const { client } = useSession();
  const open = secret !== null;
  const syncs = useApiQuery<PublicSecretSync[]>(
    ["configSecretSyncs", secret?.secretKey ?? "none", scope.kind],
    () => wrap(async () => (await client.config.listSecretSyncs(scope, { secretKey: secret!.secretKey })).syncs),
    { enabled: open },
  );

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-[520px] max-w-[94vw]">
        <SheetHeader>
          <SheetTitle>Sync provenance</SheetTitle>
          <SheetDescription>
            Where <span className="font-mono">{secret?.secretKey}</span> was materialized by deploy runs.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-2 overflow-y-auto">
          {syncs.loading ? (
            <ListSkeleton />
          ) : syncs.error ? (
            <LoadError title="Failed to load syncs" message={syncs.error.message} />
          ) : !syncs.data || syncs.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">No materialization records for this key.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Ver.</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncs.data.map((s) => {
                  const view = syncStatusView(s);
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs">{s.target}</TableCell>
                      <TableCell className="max-w-[200px] truncate font-mono text-[11px]" title={s.entityRef}>
                        {s.entityRef}
                      </TableCell>
                      <TableCell className="font-mono text-xs">v{s.version}</TableCell>
                      <TableCell>
                        <Badge variant={view.tone}>{view.label}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Break-glass reveal (SEC7) — the ONE place a value is rendered, transiently
// ---------------------------------------------------------------------------

function RevealDialog({
  scope,
  secret,
  onClose,
}: {
  scope: ConfigScope;
  secret: PublicSecretMetadata | null;
  onClose: () => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const open = secret !== null;

  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  // The revealed value lives ONLY in this local state — never react-query, never
  // storage — and is cleared the moment the dialog closes.
  const [revealed, setRevealed] = React.useState<{ value: string; version: number } | null>(null);

  const reset = React.useCallback(() => {
    setReason("");
    setError(null);
    setSubmitting(false);
    setRevealed(null);
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    const guard = revealGuard(reason);
    if (!guard.ok) {
      setError(guard.error);
      return;
    }
    setError(null);
    setSubmitting(true);
    // A mutation, not a query — the value is never cached.
    const r = await wrap(() => client.config.revealSecret(scope, secret!.id, { reason: guard.value }));
    setSubmitting(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Reveal denied", description: r.error.message });
      return;
    }
    setRevealed(r.data.secret);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-warning">
            <ShieldAlert className="h-5 w-5" /> Break-glass reveal
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">{secret?.secretKey}</DialogDescription>
        </DialogHeader>

        {revealed ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning-accent/40 bg-warning-wash p-3 text-xs text-warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Shown once. It is not stored by this page and disappears when you close this dialog.
              </span>
            </div>
            <div className="space-y-1.5">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Value (v{revealed.version})
              </span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-xs">
                  {revealed.value}
                </code>
                <CopyButton value={revealed.value} />
              </div>
            </div>
            <div className="flex justify-end pt-1">
              <Button type="button" onClick={handleClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning-accent/40 bg-warning-wash p-3 text-xs text-warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Revealing this value is an elevated action. This access is audited and alerted — your
                identity, the reason below, and the key are recorded.
              </span>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="reveal-reason" className="text-sm font-medium">
                Reason (required)
              </label>
              <textarea
                id="reveal-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="e.g. Investigating incident-1234; verifying the live key"
                className="w-full rounded-md border bg-background p-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring"
                aria-invalid={error ? true : undefined}
              />
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" onClick={() => void submit()} loading={submitting}>
                Reveal value
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
