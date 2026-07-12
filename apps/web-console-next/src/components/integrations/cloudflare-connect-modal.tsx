"use client";

// Cloudflare token-paste connect modal (IH8, design §6): the token connect
// kind. No popup, no poll — the paste IS the proof. The scope recipe renders
// inline so the parent token is created scoped-down from the start, and
// verify-before-save is server-side (the worker calls Cloudflare's
// `/user/tokens/verify` before any write): one submit, typed errors on
// failure, and the token is never stored, echoed, or logged client-side.
//
// Entitlement 412s are NOT rendered here — they're passed up to the hub's
// PreconditionInsight path via `onGateError` so plan-limit UX stays uniform.

import * as React from "react";
import { Cloud, ExternalLink } from "lucide-react";
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

/**
 * The parent-token scope recipe: the permission-group names the v1 template
 * catalog needs, mirroring TEMPLATE_PERMISSION_GROUPS in
 * `apps/integrations-worker/src/providers/cloudflare.ts`, plus the grant the
 * child-token mint call itself requires ("Account API Tokens: Edit" — a 403
 * on mint is surfaced as an insufficient parent grant).
 */
const PARENT_TOKEN_RECIPE: ReadonlyArray<{ name: string; why: string }> = [
  { name: "Account API Tokens: Edit", why: "mint and revoke the short-lived child tokens" },
  { name: "Workers Scripts: Write", why: "Deploy Workers template" },
  { name: "Workers KV Storage: Write", why: "Deploy Workers template" },
  { name: "Pages: Write", why: "Deploy Pages template" },
  { name: "DNS: Write", why: "Edit DNS template" },
  { name: "Workers R2 Storage: Write", why: "R2 data access template" },
  { name: "Account Settings: Read", why: "account discovery and read templates" },
];

const CLOUDFLARE_TOKEN_DASHBOARD_URL = "https://dash.cloudflare.com/profile/api-tokens";

const INITIAL_STATE: TokenConnectState = { phase: "idle" };

export function CloudflareConnectModal({
  orgId,
  open,
  onOpenChange,
  onConnected,
  onGateError,
}: {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Connection is already active on success — reload the list, no poll. */
  onConnected: () => void;
  /** Entitlement 412s ride the hub's PreconditionInsight path. */
  onGateError: (error: ApiErrorBody) => void;
}) {
  const { client } = useSession();
  const { toast } = useToast();
  const [state, dispatch] = React.useReducer(nextTokenConnectState, INITIAL_STATE);
  const [token, setToken] = React.useState("");

  // The token value never survives a close — and never leaves this component
  // except inside the one connect call.
  React.useEffect(() => {
    if (!open) {
      setToken("");
      dispatch({ type: "reset" });
    }
  }, [open]);
  React.useEffect(() => () => setToken(""), []);

  const submitting = state.phase === "submitting";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const pasted = token.trim();
    // Format precheck happens inside the reducer; only proceed to the API
    // call when the machine actually entered `submitting`.
    const next = nextTokenConnectState(state, { type: "submit", token: pasted });
    dispatch({ type: "submit", token: pasted });
    if (next.phase !== "submitting") return;

    const r = await wrap(() => client.integrations.connectCloudflare(orgId, { parentToken: pasted }));
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
      title: "Cloudflare connected",
      description: "The parent token was verified and stored in custody — it is never shown again.",
    });
    onOpenChange(false);
    onConnected();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden />
            Connect Cloudflare
          </DialogTitle>
          <DialogDescription>
            Paste an account-scoped parent API token once. Orun verifies it with Cloudflare before
            anything is saved, then mints short-lived child tokens from it — the parent is never
            shown again.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-[10px] border border-border bg-muted/50 px-4 py-3.5">
          <div className="text-[11px] font-semibold uppercase tracking-[.07em] text-muted-foreground">
            Token recipe
          </div>
          <p className="mt-1 text-xs leading-normal text-muted-foreground">
            Create an <span className="font-medium text-foreground">account-scoped</span> token with
            these permissions (templates you skip can be left off):
          </p>
          <ul className="mt-2 space-y-1">
            {PARENT_TOKEN_RECIPE.map((item) => (
              <li key={item.name} className="text-xs leading-normal text-muted-foreground">
                <span className="font-mono text-[11px] text-foreground">{item.name}</span>
                {" — "}
                {item.why}
              </li>
            ))}
          </ul>
          <a
            href={CLOUDFLARE_TOKEN_DASHBOARD_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary underline underline-offset-2"
          >
            Open the Cloudflare API tokens dashboard
            <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>

        <form onSubmit={(e) => void submit(e)} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cloudflare-parent-token">Parent API token</Label>
            <Input
              id="cloudflare-parent-token"
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
              Write-only: verified with Cloudflare, encrypted into custody, never echoed back.
            </p>
          </div>

          {state.phase === "error" ? <ConnectError state={state} /> : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || token.trim().length === 0}>
              {submitting ? "Verifying with Cloudflare…" : "Verify & connect"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
          ? "The token verified, but it cannot see a Cloudflare account. Re-create it with account scope and the permissions above."
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
