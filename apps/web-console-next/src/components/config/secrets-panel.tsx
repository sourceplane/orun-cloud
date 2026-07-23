"use client";

import * as React from "react";
import { z } from "zod";
import {
  Lock,
  History,
  Waypoints,
  Eye,
  MoreHorizontal,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import type { ConfigScope } from "@saas/sdk";
import type { PublicSecretMetadata, PublicSecretVersion, PublicSecretSync } from "@saas/contracts/config";
import type { PublicConnection } from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  brokerConnections,
  brokeredCreateErrorMessage,
  deriveBrokerRow,
  deriveRotationRow,
  orphanView,
  orphanedSecrets,
  templatesForProvider,
  validateBindingForm,
  validateRotationForm,
  type CreateSecretMode,
} from "./bind-secret-flow";

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isEnv = scope.kind === "environment";
  // Every ConfigScope kind carries the org — the binding picker's query scope.
  const orgId = scope.orgId;

  // Environment scope reads the whole chain; other scopes read the exact scope.
  const secrets = useApiQuery(qk.configSecrets(scopeKey), () =>
    wrap(async () =>
      isEnv
        ? (await client.config.listSecretChain(scope)).secrets
        : (await client.config.listSecretMetadata(scope)).secrets,
    ),
  );

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createMode, setCreateMode] = React.useState<CreateSecretMode>("value");
  const [rotating, setRotating] = React.useState<PublicSecretMetadata | null>(null);
  const [rotatingScoped, setRotatingScoped] = React.useState<PublicSecretMetadata | null>(null);
  const [repointing, setRepointing] = React.useState<PublicSecretMetadata | null>(null);
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

  // Deep-link (`?bind=1[&connection=int_…]`, saas-integration-hub IH8): the
  // Cmd-K "Bind brokered secret" entry and the connection detail page's
  // "Create scoped credential" button both land here with the create dialog
  // open in binding mode; `connection` pre-selects and locks that connection.
  // Seed once, then clear the params so a refresh doesn't reopen the dialog.
  const [bindConnectionId, setBindConnectionId] = React.useState<string | undefined>(undefined);
  const bindSeeded = React.useRef(false);
  React.useEffect(() => {
    if (bindSeeded.current) return;
    if (searchParams?.get("bind") === "1") {
      bindSeeded.current = true;
      const conn = searchParams.get("connection");
      if (conn) setBindConnectionId(conn);
      setCreateMode("binding");
      setCreateOpen(true);
      const next = new URLSearchParams(searchParams.toString());
      next.delete("bind");
      next.delete("connection");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    }
  }, [searchParams, pathname, router]);

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

  // brokered-orphan-safety (Feature 1): the orphaned brokered rows drive a
  // dedicated attention banner — these WILL fail to resolve at plan/run time
  // until repointed to a live connection or revoked.
  const orphaned = React.useMemo(
    () => (secrets.data ? orphanedSecrets(secrets.data) : []),
    [secrets.data],
  );

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

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) {
            setCreateMode("value");
            setBindConnectionId(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create secret</DialogTitle>
            <DialogDescription>
              {createMode === "binding"
                ? "No value is stored — the credential is minted from the connection just-in-time at resolve."
                : createMode === "rotated"
                  ? "The value is minted once from the connection, stored encrypted, and re-minted on the rotation schedule."
                  : "The value is encrypted before storage and never shown again — keep your own copy."}
            </DialogDescription>
          </DialogHeader>

          {/* A secret is a stored value (static or provider-rotated) or a
              mint-at-resolve broker binding. */}
          <div className="inline-flex self-start overflow-hidden rounded-md border">
            <button
              type="button"
              onClick={() => setCreateMode("value")}
              className={`px-2.5 py-1 text-xs ${createMode === "value" ? "bg-card font-medium" : "text-muted-foreground"}`}
            >
              Static value
            </button>
            <button
              type="button"
              onClick={() => setCreateMode("rotated")}
              className={`border-l px-2.5 py-1 text-xs ${createMode === "rotated" ? "bg-card font-medium" : "text-muted-foreground"}`}
            >
              Rotated
            </button>
            <button
              type="button"
              onClick={() => setCreateMode("binding")}
              className={`border-l px-2.5 py-1 text-xs ${createMode === "binding" ? "bg-card font-medium" : "text-muted-foreground"}`}
            >
              Scoped credential
            </button>
          </div>

          {createMode === "value" ? (
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
          ) : (
            <BindSecretForm
              scope={scope}
              orgId={orgId}
              enabled={createOpen}
              mode={createMode === "rotated" ? "rotated" : "binding"}
              initialConnectionId={bindConnectionId}
              onCancel={() => setCreateOpen(false)}
              onCreated={() => {
                const wasRotated = createMode === "rotated";
                setCreateOpen(false);
                setCreateMode("value");
                setBindConnectionId(undefined);
                toast(
                  wasRotated
                    ? { kind: "success", title: "Rotated secret created", description: "Minted from the connection and stored; it re-mints on the schedule." }
                    : { kind: "success", title: "Scoped credential created", description: "Minted at resolve — nothing is stored." },
                );
                secrets.reload();
              }}
            />
          )}
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

      <RepointSecretDialog
        scope={scope}
        orgId={orgId}
        secret={repointing}
        onClose={() => setRepointing(null)}
        onRepointed={() => {
          setRepointing(null);
          toast({ kind: "success", title: "Binding repointed", description: "The secret now mints from the new connection." });
          secrets.reload();
        }}
      />

      <RotateScopedCredentialDialog
        scope={scope}
        secret={rotatingScoped}
        onClose={() => setRotatingScoped(null)}
        onDone={(rotated) => {
          setRotatingScoped(null);
          toast({
            kind: "success",
            title: rotated ? "Scoped credential rotated" : "Rotation policy updated",
            ...(rotated
              ? { description: "The connection's source credential was rolled; runs get a fresh value." }
              : {}),
          });
          secrets.reload();
        }}
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
                // Brokered rows (IH8) lead with their binding provenance; no
                // value-shaped action (rotate/reveal) applies to them.
                const broker = deriveBrokerRow(s);
                // Provider-rotated rows (RS4) lead with their producer
                // provenance; value-shaped actions still apply (it IS stored).
                const rotationRow = deriveRotationRow(s);
                // brokered-orphan-safety (Feature 1): the derived orphan health
                // for this row (null for static / unstamped rows).
                const orphan = orphanView(s);
                const used = broker
                  ? broker.label
                  : (rotationRow?.label ??
                    s.displayName ??
                    (s.servesFrom ? `serves from ${s.servesFrom}` : null));
                return (
                  <div
                    key={s.id}
                    className={cn(
                      "grid min-w-[720px] items-center gap-3 border-t border-border/50 px-[22px] py-[13px] first:border-t-0",
                      rot.due && "bg-warning-wash",
                      orphan?.orphaned && "bg-destructive-soft/40",
                    )}
                    style={{ gridTemplateColumns: GRID_COLS }}
                  >
                    {/* Secret */}
                    <span className="min-w-0">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-mono text-[12.5px] font-semibold">{s.secretKey}</span>
                        {broker ? (
                          <Badge variant="info" className="shrink-0 text-[10.5px]">
                            brokered
                          </Badge>
                        ) : null}
                        {rotationRow ? (
                          <Badge variant="info" className="shrink-0 text-[10.5px]">
                            rotated
                          </Badge>
                        ) : null}
                        {orphan?.orphaned ? (
                          <Badge variant="destructive" className="shrink-0 gap-1 text-[10.5px]" title={orphan.reason}>
                            <TriangleAlert className="h-3 w-3" strokeWidth={2} />
                            orphaned
                          </Badge>
                        ) : null}
                      </span>
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
                          {/* Value-shaped actions don't apply to a brokered
                              binding — there is no stored value to reveal or
                              rotate (the backend rejects both). */}
                          {!broker ? (
                            <DropdownMenuItem onSelect={() => setRevealFor(s)} className="text-warning">
                              <Eye className="mr-2 h-4 w-4" /> Reveal (break-glass)
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuSeparator />
                          {!broker ? (
                            <DropdownMenuItem onSelect={() => setRotating(s)}>Rotate</DropdownMenuItem>
                          ) : null}
                          {/* SC2: a scoped credential rotates its SOURCE (the
                              connection's org-owned credential) + carries a
                              cadence — not a stored value. */}
                          {broker ? (
                            <DropdownMenuItem onSelect={() => setRotatingScoped(s)}>
                              <RefreshCw className="mr-2 h-4 w-4" /> Rotate credential
                            </DropdownMenuItem>
                          ) : null}
                          {/* Brokered rows can be repointed to a live connection —
                              the recovery path for an orphaned binding (Feature 7). */}
                          {broker ? (
                            <DropdownMenuItem onSelect={() => setRepointing(s)}>
                              <Waypoints className="mr-2 h-4 w-4" /> Repoint binding
                            </DropdownMenuItem>
                          ) : null}
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

          {orphaned.length > 0 ? (
            <AttentionBanner
              tone="error"
              action={
                <Button asChild size="sm" variant="outline">
                  <a href={`/orgs/${orgSlug}/integrations`}>Review connections</a>
                </Button>
              }
            >
              {orphaned.length === 1 ? (
                <>
                  <span className="font-mono text-[12px]">{orphaned[0]!.secretKey}</span> is orphaned — its
                  integration connection is no longer active, so it will fail to resolve at plan and run time.
                  Repoint it to a live connection or revoke it.
                </>
              ) : (
                <>
                  <span className="font-medium">{orphaned.length} brokered secrets</span> are orphaned — their
                  integration connections are no longer active, so they will fail to resolve at plan and run
                  time: <span className="font-mono text-[12px]">{orphaned.map((s) => s.secretKey).join(", ")}</span>.
                  Repoint each to a live connection or revoke it.
                </>
              )}
            </AttentionBanner>
          ) : null}

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
// Bind to integration (saas-integration-hub IH8 / IH7)
// ---------------------------------------------------------------------------

/**
 * The "Bind to integration" create path: pick a broker-capable connection →
 * scope template → params → key + display name. Binds at the panel's current
 * scope, exactly like a value create. No value ever exists — the broker mints
 * it at resolve.
 */
function BindSecretForm({
  scope,
  orgId,
  enabled,
  mode,
  onCreated,
  onCancel,
  initialConnectionId,
}: {
  scope: ConfigScope;
  orgId: string;
  enabled: boolean;
  /** "binding" = a brokered secret (minted at resolve, no stored value, IH7).
   *  "rotated" = a provider-rotated secret (value minted once + re-minted on
   *  the cadence, stored, provider-rotated-secrets RS1). Same picker; the
   *  submit path and the rotation-policy semantics differ. */
  mode: "binding" | "rotated";
  onCreated: () => void;
  onCancel: () => void;
  /** IH8: when the create flow was launched from a connection's detail page
   *  (`?bind=1&connection=int_…`), the connection is pre-selected and locked —
   *  the user is binding a scoped credential to THAT connection. */
  initialConnectionId?: string | undefined;
}) {
  const rotated = mode === "rotated";
  const { client } = useSession();

  const integrations = useApiQuery(
    qk.integrations(orgId),
    () => wrap(async () => (await client.integrations.list(orgId)).connections),
    { enabled },
  );
  // SP0c (SP-A1): provider eligibility + templates derive from the bulk
  // capability read — never a hardcoded list. Static per deploy → cache long.
  const capabilitiesQuery = useApiQuery(
    qk.secretsCapabilities(orgId),
    () => wrap(async () => (await client.integrations.listSecretsCapabilities(orgId)).capabilities),
    { enabled, staleTime: 10 * 60_000 },
  );
  const capabilities = React.useMemo(() => capabilitiesQuery.data ?? [], [capabilitiesQuery.data]);
  const connections = React.useMemo(
    () =>
      brokerConnections<PublicConnection>(
        integrations.data ?? [],
        capabilities,
        rotated ? "rotated" : "brokered",
      ),
    [integrations.data, capabilities, rotated],
  );

  const [connectionId, setConnectionId] = React.useState("");
  const [templateId, setTemplateId] = React.useState("");
  const [paramInputs, setParamInputs] = React.useState<Record<string, string>>({});
  const [secretKey, setSecretKey] = React.useState("");
  const [displayName, setDisplayName] = React.useState("");
  const [rotationPolicy, setRotationPolicy] = React.useState("");
  // Rotated-only extras (provider-rotated-secrets RS4).
  const [graceSeconds, setGraceSeconds] = React.useState("");
  const [deliverTarget, setDeliverTarget] = React.useState("");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  // Typed inline error (412 entitlement gates included) — never a silent toast.
  const [formError, setFormError] = React.useState<{ message: string; requestId: string | null } | null>(null);
  const [busy, setBusy] = React.useState(false);

  const selected = connections.find((c) => c.id === connectionId) ?? null;
  const templates = selected ? templatesForProvider(capabilities, selected.provider) : [];
  const template = templates.find((t) => t.id === templateId) ?? null;

  const pickConnection = React.useCallback(
    (id: string) => {
      setConnectionId(id);
      const conn = connections.find((c) => c.id === id);
      const first = conn ? templatesForProvider(capabilities, conn.provider)[0] : undefined;
      setTemplateId(first?.id ?? "");
      setParamInputs({});
      setErrors({});
      setFormError(null);
    },
    [connections, capabilities],
  );

  // Seed the locked connection once it appears in the broker-capable list.
  const seeded = React.useRef(false);
  React.useEffect(() => {
    if (seeded.current || !initialConnectionId) return;
    if (connections.some((c) => c.id === initialConnectionId)) {
      seeded.current = true;
      pickConnection(initialConnectionId);
    }
  }, [initialConnectionId, connections, pickConnection]);
  const locked = Boolean(initialConnectionId) && selected?.id === initialConnectionId;

  const submit = async () => {
    if (rotated) {
      const v = validateRotationForm(
        { secretKey, displayName, connectionId, template: templateId, params: paramInputs, rotationPolicy, graceSeconds, deliverTarget },
        templates,
      );
      if (!v.ok) {
        setErrors(v.errors);
        return;
      }
      setErrors({});
      setFormError(null);
      setBusy(true);
      const r = await wrap(() => client.config.createRotatedSecret(scope, v.request));
      setBusy(false);
      if (!r.ok) {
        setFormError({
          message: r.status === 412 ? brokeredCreateErrorMessage(r.error) : r.error.message,
          requestId: r.error.requestId ?? null,
        });
        return;
      }
      onCreated();
      return;
    }
    const v = validateBindingForm(
      { secretKey, displayName, connectionId, template: templateId, params: paramInputs, rotationPolicy },
      templates,
    );
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setFormError(null);
    setBusy(true);
    const r = await wrap(() => client.config.createBrokeredSecret(scope, v.request));
    setBusy(false);
    if (!r.ok) {
      if (r.status === 412) {
        setFormError({ message: brokeredCreateErrorMessage(r.error), requestId: r.error.requestId ?? null });
      } else {
        setFormError({ message: r.error.message, requestId: r.error.requestId ?? null });
      }
      return;
    }
    onCreated();
  };

  if (integrations.loading || capabilitiesQuery.loading) {
    return <p className="text-sm text-muted-foreground">Loading connections…</p>;
  }
  // SP-A5: capability reads degrade progressively — when the read fails, say
  // so; never fall back to a hardcoded provider list.
  if (capabilitiesQuery.error) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Provider capabilities are unavailable right now, so integration-backed secrets can&apos;t be
          created. Static secrets are unaffected — try again shortly.
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }
  if (connections.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {rotated
            ? "No connection from a rotation-capable provider is available. Connect one from the Integrations hub, then mint rotated secrets from it here."
            : "No broker-capable connection is available. Connect a provider from the Integrations hub, then bind secrets to it here."}
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block space-y-1.5 text-sm font-medium">
        Connection
        <select
          value={connectionId}
          onChange={(e) => pickConnection(e.target.value)}
          disabled={locked}
          className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal disabled:opacity-70"
          aria-invalid={errors.connectionId ? true : undefined}
        >
          <option value="">Select a connection…</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.provider}
              {c.displayName ? ` — ${c.displayName}` : c.externalAccountLogin ? ` — ${c.externalAccountLogin}` : ""}
            </option>
          ))}
        </select>
        {locked ? (
          <span className="block text-xs font-normal text-muted-foreground">
            {rotated
              ? "Minting the stored value from this connection."
              : "Binding a scoped credential to this connection."}
          </span>
        ) : null}
        {errors.connectionId ? <span className="block text-xs font-normal text-destructive">{errors.connectionId}</span> : null}
      </label>

      {selected ? (
        <label className="block space-y-1.5 text-sm font-medium">
          Scope template
          <select
            value={templateId}
            onChange={(e) => {
              setTemplateId(e.target.value);
              setParamInputs({});
              setErrors({});
            }}
            className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
            aria-invalid={errors.template ? true : undefined}
          >
            <option value="">Select a template…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
          {template ? <span className="block text-xs font-normal text-muted-foreground">{template.description}</span> : null}
          {errors.template ? <span className="block text-xs font-normal text-destructive">{errors.template}</span> : null}
        </label>
      ) : null}

      {template
        ? template.params.map((name) => (
            <label key={name} className="block space-y-1.5 text-sm font-medium">
              <span className="font-mono text-xs">{name}</span>
              <input
                value={paramInputs[name] ?? ""}
                onChange={(e) => setParamInputs((p) => ({ ...p, [name]: e.target.value }))}
                className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
                aria-invalid={errors[name] ? true : undefined}
              />
              {errors[name] ? <span className="block text-xs font-normal text-destructive">{errors[name]}</span> : null}
            </label>
          ))
        : null}

      <label className="block space-y-1.5 text-sm font-medium">
        Key
        <input
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          placeholder="CLOUDFLARE_API_TOKEN"
          className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
          aria-invalid={errors.secretKey ? true : undefined}
        />
        {errors.secretKey ? <span className="block text-xs font-normal text-destructive">{errors.secretKey}</span> : null}
      </label>

      <label className="block space-y-1.5 text-sm font-medium">
        Rotation policy
        <select
          value={rotationPolicy}
          onChange={(e) => setRotationPolicy(e.target.value)}
          className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
        >
          <option value="">{rotated ? "Default (every 30 days)" : "No scheduled rotation"}</option>
          <option value="30d">Every 30 days</option>
          <option value="60d">Every 60 days</option>
          <option value="90d">Every 90 days</option>
          <option value="180d">Every 180 days</option>
        </select>
        <span className="block text-xs font-normal text-muted-foreground">
          {rotated
            ? "The value is minted once from the connected parent and stored. On this cadence Orun re-mints a fresh token as a new version and retires the old one after a grace overlap."
            : "When set, Orun rolls this connection's org-owned source credential on the cadence. Every run still resolves a fresh short-lived value regardless."}
        </span>
        {errors.rotationPolicy ? <span className="block text-xs font-normal text-destructive">{errors.rotationPolicy}</span> : null}
      </label>

      {rotated ? (
        <>
          <label className="block space-y-1.5 text-sm font-medium">
            Grace overlap (seconds)
            <input
              value={graceSeconds}
              onChange={(e) => setGraceSeconds(e.target.value)}
              placeholder="Optional — default 86400 (24h)"
              inputMode="numeric"
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
              aria-invalid={errors.graceSeconds ? true : undefined}
            />
            <span className="block text-xs font-normal text-muted-foreground">
              How long the prior token stays valid after a rotation, so in-flight work keeps working.
            </span>
            {errors.graceSeconds ? <span className="block text-xs font-normal text-destructive">{errors.graceSeconds}</span> : null}
          </label>

          <label className="block space-y-1.5 text-sm font-medium">
            Deliver target
            <input
              value={deliverTarget}
              onChange={(e) => setDeliverTarget(e.target.value)}
              placeholder="Optional — e.g. cloudflare-worker:api-prod"
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
            />
            <span className="block text-xs font-normal text-muted-foreground">
              A long-lived consumer that HOLDS the value and must be re-delivered on rotation. Leave blank
              for per-run consumers that resolve the current version each run.
            </span>
          </label>
        </>
      ) : null}

      <label className="block space-y-1.5 text-sm font-medium">
        Display name
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Optional"
          className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
          aria-invalid={errors.displayName ? true : undefined}
        />
        {errors.displayName ? <span className="block text-xs font-normal text-destructive">{errors.displayName}</span> : null}
      </label>

      {formError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-xs text-destructive">
          <div>{formError.message}</div>
          {formError.requestId ? (
            <div className="mt-1 font-mono text-[11px] opacity-80">requestId: {formError.requestId}</div>
          ) : null}
        </div>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" loading={busy} onClick={() => void submit()}>
          {rotated ? "Create rotated secret" : "Bind secret"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repoint a brokered binding (brokered-orphan-safety, Feature 7)
// ---------------------------------------------------------------------------

/**
 * The recovery path for an orphaned (or simply mis-pointed) brokered secret:
 * move its binding to a different LIVE connection of the same provider. The
 * template is preserved — only the connection changes. On repoint the backend
 * re-validates the target and mints from it thereafter.
 */
/**
 * SC2: rotate a scoped credential. A brokered secret has no stored value — it
 * resolves a fresh short-lived credential every run — so "rotate" rolls the
 * connection's org-owned SOURCE credential and can set a cadence. The dialog
 * offers both: adjust the cadence, and optionally roll the source now.
 */
function RotateScopedCredentialDialog({
  scope,
  secret,
  onClose,
  onDone,
}: {
  scope: ConfigScope;
  secret: PublicSecretMetadata | null;
  onClose: () => void;
  onDone: (rotated: boolean) => void;
}) {
  const { client } = useSession();
  const open = secret !== null;
  const [cadence, setCadence] = React.useState("");
  const [rotateNow, setRotateNow] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; requestId: string | null } | null>(null);

  React.useEffect(() => {
    if (secret) {
      setCadence(secret.rotationPolicy ?? "");
      setRotateNow(true);
      setError(null);
    }
  }, [secret]);

  if (!secret) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await wrap(() =>
      client.config.rotateScopedCredential(scope, secret.id, {
        rotationPolicy: cadence === "" ? null : cadence,
        rotate: rotateNow,
      }),
    );
    setBusy(false);
    if (!r.ok) {
      setError({ message: r.error.message, requestId: r.error.requestId ?? null });
      return;
    }
    onDone(rotateNow);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate scoped credential</DialogTitle>
          <DialogDescription className="font-mono text-xs">{secret.secretKey}</DialogDescription>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          This secret has no stored value — every run resolves a fresh short-lived credential. Rotating rolls
          the connection&apos;s org-owned source credential
          {secret.binding ? <> ({secret.binding.provider})</> : null}; all scoped credentials on that
          connection then draw from the fresh source.
        </p>

        <label className="block space-y-1.5 text-sm font-medium">
          Rotation policy
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value)}
            className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
          >
            <option value="">No scheduled rotation</option>
            <option value="30d">Every 30 days</option>
            <option value="60d">Every 60 days</option>
            <option value="90d">Every 90 days</option>
            <option value="180d">Every 180 days</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={rotateNow} onChange={(e) => setRotateNow(e.target.checked)} />
          Roll the source credential now
        </label>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-xs text-destructive">
            <div>{error.message}</div>
            {error.requestId ? <div className="mt-1 font-mono text-[11px] opacity-80">requestId: {error.requestId}</div> : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" loading={busy} onClick={() => void submit()}>
            {rotateNow ? "Rotate now" : "Save policy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepointSecretDialog({
  scope,
  orgId,
  secret,
  onClose,
  onRepointed,
}: {
  scope: ConfigScope;
  orgId: string;
  secret: PublicSecretMetadata | null;
  onClose: () => void;
  onRepointed: () => void;
}) {
  const { client } = useSession();
  const open = secret !== null;
  const broker = secret ? deriveBrokerRow(secret) : null;

  const integrations = useApiQuery(
    qk.integrations(orgId),
    () => wrap(async () => (await client.integrations.list(orgId)).connections),
    { enabled: open },
  );
  // Candidates: live connections of the SAME provider, minus the connection
  // the secret is already (orphaned) bound to. Same-provider is a stronger
  // constraint than capability-declared (the provider was declared at create),
  // so no capability read is needed here (SP0c).
  const candidates = React.useMemo(() => {
    const all = (integrations.data ?? []).filter((c) => c.status === "active");
    return all.filter((c) => c.provider === broker?.provider && c.id !== broker?.connectionId);
  }, [integrations.data, broker?.provider, broker?.connectionId]);

  const [connectionId, setConnectionId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; requestId: string | null } | null>(null);

  // Reset the picker each time the dialog opens for a new secret.
  React.useEffect(() => {
    if (open) {
      setConnectionId("");
      setError(null);
      setBusy(false);
    }
  }, [open, secret?.id]);

  const submit = async () => {
    if (!secret || !connectionId) {
      setError({ message: "Pick a connection to repoint to.", requestId: null });
      return;
    }
    setBusy(true);
    setError(null);
    const r = await wrap(() =>
      client.config.repointBrokeredSecret(scope, secret.id, { binding: { connectionId } }),
    );
    setBusy(false);
    if (!r.ok) {
      setError({ message: r.error.message, requestId: r.error.requestId ?? null });
      return;
    }
    onRepointed();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Repoint binding</DialogTitle>
          <DialogDescription className="font-mono text-xs">{secret?.secretKey}</DialogDescription>
        </DialogHeader>

        {broker ? (
          <p className="text-xs text-muted-foreground">
            Currently bound to a {broker.provider} connection via <span className="font-mono">{broker.template}</span>.
            Pick another live {broker.provider} connection to mint from — the template is preserved.
          </p>
        ) : null}

        {integrations.loading ? (
          <p className="text-sm text-muted-foreground">Loading connections…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No other live {broker?.provider} connection is available. Connect one from the Integrations hub, then
            repoint here.
          </p>
        ) : (
          <label className="block space-y-1.5 text-sm font-medium">
            New connection
            <select
              value={connectionId}
              onChange={(e) => setConnectionId(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
            >
              <option value="">Select a connection…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.provider}
                  {c.displayName ? ` — ${c.displayName}` : c.externalAccountLogin ? ` — ${c.externalAccountLogin}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-xs text-destructive">
            <div>{error.message}</div>
            {error.requestId ? (
              <div className="mt-1 font-mono text-[11px] opacity-80">requestId: {error.requestId}</div>
            ) : null}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" loading={busy} disabled={candidates.length === 0} onClick={() => void submit()}>
            Repoint
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
