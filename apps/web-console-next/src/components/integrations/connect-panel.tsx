"use client";

// The integration space's connect surface (saas-integration-registry IR3):
// renders the descriptor's ORDERED connect methods — first live method is
// primary, the rest offered beneath — with zero provider-name branches. The
// token method's recipe comes from the served descriptor (derived from the
// adapter's own grant grammar); the console holds no copy. Replaces the
// Cloudflare-specific connect modal.
//
// Token-paste discipline (unchanged from IH8): no popup, no poll — the paste
// IS the proof; verify-before-save is server-side; the value never survives
// a close and never leaves this component except inside the one connect
// call. Entitlement 412s are passed up so plan-limit UX stays uniform.

import * as React from "react";
import { ExternalLink, Plug } from "lucide-react";
import type {
  IntegrationConnectMethod,
  IntegrationDescriptor,
} from "@saas/contracts/integrations";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/toast";
import { wrap, type ApiErrorBody } from "@/lib/api";
import { useSession } from "@/lib/session";
import {
  classifyTokenConnectFailure,
  nextTokenConnectState,
  type TokenConnectState,
} from "@/components/integrations/token-connect-flow";

const INITIAL_STATE: TokenConnectState = { phase: "idle" };

export function IntegrationConnectDialog({
  orgId,
  descriptor,
  open,
  onOpenChange,
  onConnected,
  onGateError,
  onPopupConnect,
}: {
  orgId: string;
  descriptor: IntegrationDescriptor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Token-kind success: connection is already active — reload, no poll. */
  onConnected: () => void;
  /** Entitlement 412s ride the caller's PreconditionInsight path. */
  onGateError: (error: ApiErrorBody) => void;
  /** Runs the popup+poll flow for a live install/oauth method. */
  onPopupConnect: () => void;
}) {
  const methods = descriptor.connect;
  const primary = methods.find((m) => m.live);
  const tokenMethod = methods.find((m) => m.kind === "token");
  const popupMethod = methods.find((m) => (m.kind === "oauth" || m.kind === "install") && m.live);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plug className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
            Connect {descriptor.displayName}
          </DialogTitle>
          <DialogDescription>{descriptor.tagline}</DialogDescription>
        </DialogHeader>

        {popupMethod ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-border px-4 py-3.5">
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold">
                  {popupMethod.kind === "install" ? "Install the app" : `Authorize with ${descriptor.displayName}`}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Approve once on {descriptor.displayName}&apos;s side — the platform custodies its
                  own credential; your login is never kept.
                </p>
              </div>
              <Button type="button" className="shrink-0" onClick={onPopupConnect}>
                {popupMethod.kind === "install" ? "Install" : "Authorize"}
              </Button>
            </div>
            {tokenMethod?.live ? (
              <div className="flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
                <span className="h-px flex-1 bg-border" aria-hidden />
                or paste a token
                <span className="h-px flex-1 bg-border" aria-hidden />
              </div>
            ) : null}
          </>
        ) : null}

        {tokenMethod?.live ? (
          <TokenConnectForm
            orgId={orgId}
            descriptor={descriptor}
            method={tokenMethod}
            onOpenChange={onOpenChange}
            onConnected={onConnected}
            onGateError={onGateError}
          />
        ) : null}

        {!primary ? (
          <div className="rounded-[10px] border border-border bg-muted/50 px-4 py-3.5 text-xs text-muted-foreground">
            No connect method is configured for this environment yet — an operator registers the
            provider credentials per environment.
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TokenConnectForm({
  orgId,
  descriptor,
  method,
  onOpenChange,
  onConnected,
  onGateError,
}: {
  orgId: string;
  descriptor: IntegrationDescriptor;
  method: IntegrationConnectMethod;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
  onGateError: (error: ApiErrorBody) => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [state, dispatch] = React.useReducer(nextTokenConnectState, INITIAL_STATE);
  const [token, setToken] = React.useState("");

  React.useEffect(() => () => setToken(""), []);

  const submitting = state.phase === "submitting";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const pasted = token.trim();
    const next = nextTokenConnectState(state, { type: "submit", token: pasted });
    dispatch({ type: "submit", token: pasted });
    if (next.phase !== "submitting") return;

    const r = await wrap(() =>
      client.integrations.connect(orgId, descriptor.id, { parentToken: pasted }),
    );
    if (!r.ok) {
      const kind = classifyTokenConnectFailure(r.status, r.error);
      if (kind === "entitlement") {
        setToken("");
        dispatch({ type: "reset" });
        onOpenChange(false);
        onGateError(r.error);
        return;
      }
      dispatch({
        type: "failed",
        kind,
        message: r.error.message,
        requestId: r.error.requestId ?? null,
      });
      return;
    }

    setToken("");
    dispatch({ type: "succeeded" });
    toast({
      kind: "success",
      title: `${descriptor.displayName} connected`,
      description: "The token was verified and stored in custody — it is never shown again.",
    });
    onOpenChange(false);
    onConnected();
  };

  return (
    <>
      {method.recipe ? (
        <div className="rounded-[10px] border border-border bg-muted/50 px-4 py-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
            Token recipe
          </div>
          <p className="mt-1 text-xs leading-normal text-muted-foreground">{method.recipe.intro}</p>
          <ul className="mt-2 space-y-1">
            {method.recipe.items.map((item) => (
              <li key={item.name} className="text-xs leading-normal text-muted-foreground">
                <span className="font-mono text-[11px] text-foreground">{item.name}</span>
                {" — "}
                {item.why}
              </li>
            ))}
          </ul>
          {method.recipe.links.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
              {method.recipe.links.map((link) => (
                <a
                  key={link.url}
                  href={link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-2"
                >
                  {link.label}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="integration-parent-token">Parent API token</Label>
          <Input
            id="integration-parent-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="Paste the token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            disabled={submitting}
            aria-invalid={state.phase === "error"}
          />
          <p className="text-xs text-muted-foreground">
            Write-only: verified with {descriptor.displayName}, encrypted into custody, never echoed
            back.
          </p>
        </div>

        {state.phase === "error" ? <ConnectError state={state} /> : null}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || token.trim().length === 0}>
            {submitting ? `Verifying with ${descriptor.displayName}…` : "Verify & connect"}
          </Button>
        </div>
      </form>
    </>
  );
}

/** Typed-error rendering; never includes the pasted value. */
function ConnectError({ state }: { state: Extract<TokenConnectState, { phase: "error" }> }) {
  const hint =
    state.kind === "invalid_format"
      ? null
      : state.kind === "verify_failed"
        ? "Check that the token is active and was copied in full, then paste it again."
        : state.kind === "parent_grant"
          ? "The token verified, but it cannot see an account. Re-create it with account scope and the permissions above."
          : "The connection could not be created right now. Try again shortly.";
  return (
    <div
      role="alert"
      className="rounded-[10px] border border-destructive/40 bg-destructive/5 px-3.5 py-2.5"
    >
      <div className="text-[12.5px] font-medium text-destructive">{state.message}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      {state.requestId ? (
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
          requestId: {state.requestId}
        </div>
      ) : null}
    </div>
  );
}
