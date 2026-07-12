"use client";

import * as React from "react";
import { AlertTriangle, Lock, Sparkles, Wrench, Info } from "lucide-react";
import type { ApiErrorBody } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

/**
 * Designed plan-limit / upgrade UX.
 *
 * Renders one of four shapes based on the entitlement seam's `reason`:
 *   - limit_reached     → upgrade CTA with usage vs limit bar
 *   - disabled          → entitlement disabled for this org/plan, contact sales
 *   - not_configured    → billing not yet configured for this org
 *   - malformed_limit   → internal hint (billing provider misconfiguration)
 *
 * The four reason codes are documented in ai/context/current.md.
 * Request ID is always reachable behind a Details disclosure.
 */
export interface PreconditionInsightProps {
  error: ApiErrorBody;
  resource?: "project" | "environment" | "invitation" | string;
  onUpgrade?: () => void;
  onTalkToSales?: () => void;
  onDismiss?: () => void;
  className?: string;
}

interface Usage {
  limit?: number | undefined;
  current?: number | undefined;
  key?: string | undefined;
}

function extractUsage(error: ApiErrorBody): Usage {
  const d = error.details ?? {};
  const out: Usage = {};
  if (typeof d.limit === "number") out.limit = d.limit;
  if (typeof d.current === "number") out.current = d.current;
  if (typeof d.key === "string") out.key = d.key;
  return out;
}

export function PreconditionInsight({
  error,
  resource = "resource",
  onUpgrade,
  onTalkToSales,
  onDismiss,
  className,
}: PreconditionInsightProps) {
  const reason = error.reason ?? "limit_reached";
  const usage = extractUsage(error);
  const limitKey = usage.key ?? resource;
  const [open, setOpen] = React.useState(false);

  let icon: React.ReactNode;
  let title: string;
  let body: React.ReactNode;
  let primary: { label: string; onClick: () => void } | null = null;
  let secondary: { label: string; onClick: () => void } | null = null;
  let tone: "warning" | "destructive" | "default" = "warning";

  switch (reason) {
    case "limit_reached": {
      tone = "warning";
      icon = <Sparkles className="h-5 w-5" />;
      title = `You've hit your ${friendly(limitKey)} limit`;
      body = (
        <>
          <p className="text-sm text-muted-foreground">
            Your current plan allows {usage.limit ?? "—"} {friendly(limitKey)}
            {usage.current != null ? <> · you're at <strong>{usage.current}</strong></> : null}. Upgrade your
            plan to create more, or talk to us about a custom tier.
          </p>
          {usage.limit != null && usage.current != null && (
            <UsageBar current={usage.current} limit={usage.limit} />
          )}
        </>
      );
      if (onUpgrade) primary = { label: "Upgrade plan", onClick: onUpgrade };
      if (onTalkToSales) secondary = { label: "Talk to sales", onClick: onTalkToSales };
      break;
    }
    case "disabled": {
      tone = "destructive";
      icon = <Lock className="h-5 w-5" />;
      title = `${capitalize(friendly(limitKey))} are disabled on your plan`;
      body = (
        <p className="text-sm text-muted-foreground">
          Your workspace doesn't currently have access to {friendly(limitKey)}. Contact your account
          team to enable this entitlement.
        </p>
      );
      if (onTalkToSales) primary = { label: "Talk to sales", onClick: onTalkToSales };
      break;
    }
    case "not_configured": {
      tone = "default";
      icon = <Wrench className="h-5 w-5" />;
      // The connect/repo-link gates reuse `not_configured` for a non-billing
      // cause: the environment's provider app/custody isn't set up yet. Detect
      // ANY gate so we never send people to the Billing tab for a
      // platform-setup step that billing can't fix (IH1/IH5/IH6 gates:
      // slack_app_registration, cloudflare_custody, supabase_oauth_registration).
      if (typeof error.details?.gate === "string") {
        const gateCopy: Record<string, { title: string; body: string }> = {
          github_app_registration: {
            title: "GitHub isn't set up for this workspace yet",
            body:
              "The GitHub App for this environment hasn't been configured yet, so connections can't be created. This is a one-time platform setup step (registering the GitHub App) — not a billing issue. Ask an administrator to finish GitHub App setup, then try again.",
          },
          slack_app_registration: {
            title: "Slack isn't enabled on this environment yet",
            body:
              "The per-environment Slack App hasn't been registered yet, so Slack connections can't be created. This is a one-time platform setup step (registering the Slack App and installing its credentials) — not a billing issue. Ask an administrator to finish Slack App setup, then try again.",
          },
          supabase_oauth_registration: {
            title: "Supabase isn't enabled on this environment yet",
            body:
              "The per-environment Supabase OAuth app hasn't been registered yet, so Supabase connections can't be created. This is a one-time platform setup step — not a billing issue. Ask an administrator to finish Supabase OAuth setup, then try again.",
          },
          cloudflare_custody: {
            title: "Credential custody isn't configured on this environment yet",
            body:
              "Cloudflare connections store the pasted parent token in encrypted custody, and this environment's custody encryption isn't configured yet. This is a platform setup step — not a billing issue. Ask an administrator to finish environment setup, then try again.",
          },
        };
        const copy = gateCopy[error.details.gate] ?? {
          title: "This integration isn't enabled on this environment yet",
          body:
            "A one-time platform setup step for this provider hasn't been completed on this environment. This is not a billing issue. Ask an administrator to finish provider setup, then try again.",
        };
        title = copy.title;
        body = <p className="text-sm text-muted-foreground">{copy.body}</p>;
        // No primary CTA: opening Billing wouldn't resolve a platform-setup gate.
        break;
      }
      title = "Billing isn't configured yet";
      body = (
        <p className="text-sm text-muted-foreground">
          We can't validate your {friendly(limitKey)} entitlement because billing hasn't been set up for
          this workspace. Finish setup in the Billing tab, then try again.
        </p>
      );
      if (onUpgrade) primary = { label: "Open Billing", onClick: onUpgrade };
      break;
    }
    case "malformed_limit": {
      tone = "destructive";
      icon = <AlertTriangle className="h-5 w-5" />;
      title = "Billing provider returned an unexpected limit";
      body = (
        <p className="text-sm text-muted-foreground">
          We received a malformed entitlement value from your billing provider. This is a configuration
          issue on our side — our team has been notified. Please retry, or contact support with the
          request ID below.
        </p>
      );
      if (onTalkToSales) primary = { label: "Contact support", onClick: onTalkToSales };
      break;
    }
    default: {
      icon = <Info className="h-5 w-5" />;
      title = error.message || "Action blocked";
      body = <p className="text-sm text-muted-foreground">{error.message}</p>;
    }
  }

  return (
    <Card
      className={cn(
        "border-2 animate-fade-in",
        tone === "warning" && "border-warning/40 bg-warning/5",
        tone === "destructive" && "border-destructive/40 bg-destructive/5",
        tone === "default" && "border-primary/40 bg-primary/5",
        className,
      )}
      data-testid={`precondition-${reason}`}
    >
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full",
            tone === "warning" && "bg-warning/20 text-warning-foreground",
            tone === "destructive" && "bg-destructive/20 text-destructive",
            tone === "default" && "bg-primary/20 text-primary",
          )}
        >
          {icon}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              {reason.replace(/_/g, " ")}
            </Badge>
          </div>
          <CardDescription className="mt-1">
            <span className="font-mono text-xs">precondition_failed</span> · resource:{" "}
            <span className="font-mono text-xs">{resource}</span>
          </CardDescription>
        </div>
        {onDismiss && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {body}
        <div className="flex flex-wrap items-center gap-2">
          {primary && <Button onClick={primary.onClick}>{primary.label}</Button>}
          {secondary && (
            <Button variant="outline" onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen((x) => !x)}>
            {open ? "Hide details" : "Details"}
          </Button>
        </div>
        {open && (
          <div className="rounded-md border bg-background/60 p-3 text-xs font-mono space-y-1">
            <div><span className="text-muted-foreground">code: </span>{error.code}</div>
            <div><span className="text-muted-foreground">reason: </span>{reason}</div>
            {error.requestId && (
              <div><span className="text-muted-foreground">requestId: </span>{error.requestId}</div>
            )}
            {error.details && (
              <div className="text-muted-foreground whitespace-pre-wrap break-all pt-1">
                {JSON.stringify(error.details, null, 2)}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function UsageBar({ current, limit }: { current: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 100;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">Usage</span>
        <span className="font-medium">
          {current} / {limit}
        </span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", pct >= 100 ? "bg-destructive" : "bg-warning")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function friendly(key: string): string {
  // turns "limit.projects" / "projects" / "members" into a human plural
  const last = key.split(".").pop() ?? key;
  return last.replace(/_/g, " ");
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
