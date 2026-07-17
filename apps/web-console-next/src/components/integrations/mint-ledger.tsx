"use client";

// The credential-broker mint ledger + "Mint credential" dialog
// (saas-integration-hub IH8, design §6: "the mint ledger (template, purpose,
// actor/run link, expiry, revoke action)").
//
// The ledger never carries credential values — only the mint dialog's success
// pane does, exactly once, held in the pure state machine (mint-flow.ts) whose
// `close` transition drops it. Never toasted, never logged, never cached.

import * as React from "react";
import { KeyRound, TriangleAlert } from "lucide-react";
import type { ListMintedCredentialsResponse, PublicMintedCredential } from "@saas/contracts/integrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Pill } from "@/components/ui/northwind";
import { PreconditionInsight } from "@/components/precondition/insight";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { ListSkeleton, LoadError } from "@/components/config/config-shared";
import {
  classifyMintError,
  formatRelative,
  mintPurposeView,
  mintStatusView,
  nextMintState,
  validateMintForm,
  DEFAULT_MINT_TTL_SECONDS,
  MIN_MINT_TTL_SECONDS,
  type MintState,
  type MintTemplateLike,
} from "./mint-flow";

export interface MintLedgerTemplate extends MintTemplateLike {
  description?: string;
}

export function MintLedger({
  orgId,
  connectionId,
  templates,
  canMint,
}: {
  orgId: string;
  connectionId: string;
  /** The connection provider's scope-template catalog (archetype.ts). */
  templates: readonly MintLedgerTemplate[];
  /** Infrastructure archetype only — hides the mint button elsewhere. */
  canMint: boolean;
}) {
  const { client } = useSession();
  const { toast } = useToast();

  const ledger = useApiQuery<ListMintedCredentialsResponse>(
    qk.mintedCredentials(orgId, connectionId),
    () => wrap(() => client.integrations.listMintedCredentials(orgId, connectionId)),
  );

  const [mintOpen, setMintOpen] = React.useState(false);
  const [revokeTarget, setRevokeTarget] = React.useState<PublicMintedCredential | null>(null);
  const now = React.useMemo(() => new Date(), [ledger.data]);

  const revoke = async (mint: PublicMintedCredential) => {
    const r = await wrap(() => client.integrations.revokeMintedCredential(orgId, connectionId, mint.id));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Credential revoked", description: "Best-effort provider revoke; the TTL is the backstop." });
    ledger.reload();
  };

  const mints = ledger.data?.mints ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13.5px] font-semibold">Mint ledger</div>
        {canMint && templates.length > 0 ? (
          <Button size="sm" onClick={() => setMintOpen(true)}>
            Mint credential
          </Button>
        ) : null}
      </div>

      {ledger.loading ? (
        <ListSkeleton />
      ) : ledger.error ? (
        <LoadError title="Failed to load the mint ledger" message={ledger.error.message} />
      ) : mints.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No credentials minted yet"
          description="Short-lived credentials minted against this connection — by operators, or by runs resolving brokered secrets — are recorded here, never their values."
          {...(canMint && templates.length > 0
            ? { primaryAction: { label: "Mint credential", onClick: () => setMintOpen(true) } }
            : {})}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Purpose</TableHead>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Minted → expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="sr-only">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mints.map((mint) => {
                  const purpose = mintPurposeView(mint.purpose);
                  const status = mintStatusView(mint, now);
                  const revocable = status.label === "Active" && mint.revokeStatus === "pending";
                  return (
                    <TableRow key={mint.id}>
                      <TableCell className="font-mono text-xs">
                        {mint.template}
                        {/* SI6: which custody class authorized the mint — a
                            user-derived parent is the deprecation tail. */}
                        {mint.parentKind ? (
                          <span
                            className="mt-0.5 block text-[10.5px] text-muted-foreground"
                            title={`Authorized by custody: ${mint.parentKind}`}
                          >
                            {mint.parentKind.endsWith("refresh_token")
                              ? "via user-derived token (deprecated)"
                              : "via service identity"}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant={purpose.variant}>{purpose.label}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[200px]">
                        <span className="block truncate font-mono text-[11px]">
                          {mint.requestedBy ?? (mint.purpose === "secret_resolve" ? "platform (resolve)" : "—")}
                        </span>
                        {mint.runId ? (
                          <span className="block truncate font-mono text-[11px] text-muted-foreground" title={mint.runId}>
                            run {mint.runId}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatRelative(mint.mintedAt, now)} → {formatRelative(mint.expiresAt, now)}
                      </TableCell>
                      <TableCell>
                        <Pill tone={status.tone} dot>
                          {status.label}
                        </Pill>
                      </TableCell>
                      <TableCell className="text-right">
                        {revocable ? (
                          <Button size="sm" variant="ghost" onClick={() => setRevokeTarget(mint)}>
                            Revoke
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {ledger.data?.nextCursor ? (
            <div className="border-t px-4 py-2 text-xs text-muted-foreground">
              Showing the newest mints — older entries are in the audit log.
            </div>
          ) : null}
        </div>
      )}

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title="Revoke minted credential?"
        description="Best-effort revoke on the provider side; the credential's TTL is the backstop either way. Anything still using it stops working."
        resourceName={revokeTarget ? `${revokeTarget.template} · ${revokeTarget.id}` : undefined}
        confirmLabel="Revoke credential"
        onConfirm={async () => {
          if (revokeTarget) await revoke(revokeTarget);
        }}
      />

      <MintDialog
        open={mintOpen}
        onClose={() => setMintOpen(false)}
        orgId={orgId}
        connectionId={connectionId}
        templates={templates}
        onMinted={() => ledger.reload()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mint dialog — pick → confirm → minting → revealed | error (mint-flow.ts)
// ---------------------------------------------------------------------------

function MintDialog({
  open,
  onClose,
  orgId,
  connectionId,
  templates,
  onMinted,
}: {
  open: boolean;
  onClose: () => void;
  orgId: string;
  connectionId: string;
  templates: readonly MintLedgerTemplate[];
  onMinted: () => void;
}) {
  const { client } = useSession();
  const [state, setState] = React.useState<MintState>({ phase: "pick" });

  // Form inputs (pick phase). The credential itself NEVER lives here — only in
  // the machine's `revealed` state, which `close` drops.
  const [templateId, setTemplateId] = React.useState<string>(templates[0]?.id ?? "");
  const [paramInputs, setParamInputs] = React.useState<Record<string, string>>({});
  const [ttlInput, setTtlInput] = React.useState("");
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const template = templates.find((t) => t.id === templateId) ?? templates[0] ?? null;

  const handleClose = React.useCallback(() => {
    // Reset the machine first: `close` always returns to `pick`, dropping any
    // revealed credential from state before the dialog unmounts its pane.
    setState((s) => nextMintState(s, { type: "close" }));
    setTemplateId(templates[0]?.id ?? "");
    setParamInputs({});
    setTtlInput("");
    setFieldErrors({});
    onClose();
  }, [onClose, templates]);

  const review = () => {
    if (!template) return;
    const v = validateMintForm(template, paramInputs, ttlInput);
    if (!v.ok) {
      setFieldErrors(v.errors);
      return;
    }
    setFieldErrors({});
    setState((s) =>
      nextMintState(s, { type: "review", templateId: template.id, params: v.params, ttlSeconds: v.ttlSeconds }),
    );
  };

  const confirmMint = async () => {
    if (state.phase !== "confirm") return;
    const { templateId: tpl, params, ttlSeconds } = state;
    setState((s) => nextMintState(s, { type: "confirmMint" }));
    const r = await wrap(() =>
      client.integrations.mintCredential(orgId, connectionId, {
        template: tpl,
        ...(Object.keys(params).length > 0 ? { params } : {}),
        ttlSeconds,
      }),
    );
    if (!r.ok) {
      setState((s) => nextMintState(s, { type: "mintFailed", reason: classifyMintError(r.status, r.error) }));
      return;
    }
    onMinted();
    setState((s) =>
      nextMintState(s, {
        type: "mintSucceeded",
        credential: r.data.credential,
        mintId: r.data.mint.id,
        expiresAt: r.data.mint.expiresAt,
      }),
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) handleClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mint credential</DialogTitle>
          <DialogDescription>
            A short-lived, scope-template credential minted against this connection. The value is shown exactly
            once and recorded in the ledger — never the credential itself.
          </DialogDescription>
        </DialogHeader>

        {state.phase === "pick" && template ? (
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              Scope template
              <select
                value={template.id}
                onChange={(e) => {
                  setTemplateId(e.target.value);
                  setParamInputs({});
                  setFieldErrors({});
                }}
                className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 text-sm font-normal"
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            </label>
            {template.description ? (
              <p className="text-xs text-muted-foreground">{template.description}</p>
            ) : null}

            {template.params.map((name) => (
              <label key={name} className="block space-y-1.5 text-sm font-medium">
                <span className="font-mono text-xs">{name}</span>
                <input
                  value={paramInputs[name] ?? ""}
                  onChange={(e) => setParamInputs((p) => ({ ...p, [name]: e.target.value }))}
                  className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
                  aria-invalid={fieldErrors[name] ? true : undefined}
                />
                {fieldErrors[name] ? <span className="block text-xs font-normal text-destructive">{fieldErrors[name]}</span> : null}
              </label>
            ))}

            <label className="block space-y-1.5 text-sm font-medium">
              TTL (seconds)
              <input
                value={ttlInput}
                onChange={(e) => setTtlInput(e.target.value)}
                placeholder={`${Math.min(DEFAULT_MINT_TTL_SECONDS, template.maxTtlSeconds)}`}
                inputMode="numeric"
                className="mt-1.5 h-9 w-full rounded-md border bg-card px-2 font-mono text-xs"
                aria-invalid={fieldErrors.ttl ? true : undefined}
              />
              <span className="block text-xs font-normal text-muted-foreground">
                Default {Math.min(DEFAULT_MINT_TTL_SECONDS, template.maxTtlSeconds)}s · between {MIN_MINT_TTL_SECONDS}s and{" "}
                {template.maxTtlSeconds}s for this template.
              </span>
              {fieldErrors.ttl ? <span className="block text-xs font-normal text-destructive">{fieldErrors.ttl}</span> : null}
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={handleClose}>
                Cancel
              </Button>
              <Button type="button" onClick={review}>
                Review
              </Button>
            </div>
          </div>
        ) : null}

        {state.phase === "confirm" || state.phase === "minting" ? (
          <div className="space-y-3">
            <dl className="space-y-1.5 rounded-md border bg-muted/20 p-3 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Template</dt>
                <dd className="font-mono">{state.templateId}</dd>
              </div>
              {Object.entries(state.params).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2">
                  <dt className="font-mono text-muted-foreground">{k}</dt>
                  <dd className="truncate font-mono">{v}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">TTL</dt>
                <dd className="font-mono">{state.ttlSeconds}s</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              The minted value appears once on the next screen and cannot be retrieved again. The mint is recorded
              in the ledger and the audit log.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                disabled={state.phase === "minting"}
                onClick={() => setState((s) => nextMintState(s, { type: "back" }))}
              >
                Back
              </Button>
              <Button type="button" loading={state.phase === "minting"} onClick={() => void confirmMint()}>
                Mint credential
              </Button>
            </div>
          </div>
        ) : null}

        {state.phase === "revealed" ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-warning-accent/40 bg-warning-wash p-3 text-xs text-warning">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Shown exactly once — it cannot be retrieved again. Copy it now; it disappears when you close this
                dialog. Expires {formatRelative(state.expiresAt, new Date())}.
              </span>
            </div>
            {Object.entries(state.credential).map(([k, v]) => (
              <div key={k} className="space-y-1.5">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{k}</span>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 font-mono text-xs">
                    {v}
                  </code>
                  <CopyButton value={v} />
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Ledger entry <span className="font-mono">{state.mintId}</span> records the template, params, and
              expiry — never the value.
            </p>
            <div className="flex justify-end pt-1">
              <Button type="button" onClick={handleClose}>
                Done
              </Button>
            </div>
          </div>
        ) : null}

        {state.phase === "error" ? (
          <div className="space-y-3">
            {state.reason.kind === "entitlement" ? (
              <PreconditionInsight error={state.reason.error} resource="credential mint" />
            ) : (
              <div className="rounded-md border border-destructive/40 bg-destructive-soft p-3 text-xs text-destructive">
                <div className="font-medium">Mint failed</div>
                <div className="mt-1">{state.reason.message}</div>
                {state.reason.requestId ? (
                  <div className="mt-1 font-mono text-[11px] opacity-80">requestId: {state.reason.requestId}</div>
                ) : null}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={handleClose}>
                Close
              </Button>
              <Button type="button" onClick={() => setState((s) => nextMintState(s, { type: "back" }))}>
                Back
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
