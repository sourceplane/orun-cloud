"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, Bot, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";
import type { OAuthClientInfo } from "@saas/contracts/auth";
import {
  parseAuthorizeRequest,
  buildApproveRedirect,
  buildDenyRedirect,
  dynamicClientRedirectAllowed,
  consentClientPresentation,
} from "@/lib/oauth-consent";

/**
 * OAuth 2.1 consent page (saas-mcp-server MCP3 + MCP11 leg B) — the
 * authorization endpoint named in the RFC 8414 metadata. An MCP client
 * (Claude, Cursor, VS Code, …) sends the user here with the standard query
 * params; this page requires the existing console login (app-shell
 * `useRequireAuth`), shows who is asking, and on approval calls
 * `auth.oauthAuthorizeComplete` for a single-use code, then redirects back to
 * the client's registered redirect_uri.
 *
 * Client identity: the vetted allow-list resolves first (risks D1, Option A);
 * dynamically-registered `dcr_` clients (RFC 7591 DCR — D1 → Option B,
 * MCP11 leg B) are fetched via `auth.getOAuthClientInfo` and ALWAYS render
 * with the "Unverified app" treatment — the name is self-reported
 * registration data, never trusted-client styling. Unknown clients or
 * unregistered redirect URIs render an error and NEVER redirect (approve AND
 * deny paths). The minted token is workspace-agnostic, exactly like an OP1
 * CLI session (it can act as the user in all their workspaces until revoked).
 */
export default function OAuthAuthorizePage() {
  const searchParams = useSearchParams();
  const { client: api } = useSession();
  const { toast } = useToast();
  const [busy, setBusy] = React.useState(false);
  const [decision, setDecision] = React.useState<"approved" | "denied" | null>(null);
  const [dynamicClient, setDynamicClient] = React.useState<OAuthClientInfo | null>(null);
  const [dynamicError, setDynamicError] = React.useState<string | null>(null);

  const parsed = React.useMemo(() => parseAuthorizeRequest(searchParams), [searchParams]);

  // Dynamic (`dcr_`) clients: resolve the registration server-side, then run
  // the SAME redirect pre-check as static clients. Until both pass, nothing
  // renders that could redirect the user agent.
  const dynamicClientId = parsed.ok && parsed.kind === "dynamic" ? parsed.clientId : null;
  const dynamicRedirectUri = parsed.ok && parsed.kind === "dynamic" ? parsed.params.redirectUri : null;
  React.useEffect(() => {
    if (!dynamicClientId || !dynamicRedirectUri) return;
    let cancelled = false;
    void (async () => {
      const r = await wrap(() => api.auth.getOAuthClientInfo(dynamicClientId));
      if (cancelled) return;
      if (!r.ok) {
        setDynamicError("Unknown client — its registration was not found or has expired.");
        return;
      }
      if (!dynamicClientRedirectAllowed(r.data.client, dynamicRedirectUri)) {
        setDynamicError("The redirect_uri is not registered for this client.");
        return;
      }
      setDynamicClient(r.data.client);
    })();
    return () => {
      cancelled = true;
    };
  }, [api, dynamicClientId, dynamicRedirectUri]);

  if (!parsed.ok) {
    return <InvalidRequest error={parsed.error} />;
  }
  if (dynamicError) {
    return <InvalidRequest error={dynamicError} />;
  }

  const { params } = parsed;
  const resolved =
    parsed.kind === "static"
      ? { name: parsed.client.name, dynamic: false }
      : dynamicClient
        ? { name: dynamicClient.name, dynamic: true }
        : null;

  if (!resolved) {
    return (
      <Centered>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Looking up client registration&hellip;</CardTitle>
            <CardDescription>Verifying who is asking to connect.</CardDescription>
          </CardHeader>
        </Card>
      </Centered>
    );
  }

  const presentation = consentClientPresentation(resolved);

  const approve = async () => {
    setBusy(true);
    const r = await wrap(() =>
      api.auth.oauthAuthorizeComplete({
        clientId: params.clientId,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        codeChallengeMethod: "S256",
        ...(params.scope !== null ? { scope: params.scope } : {}),
      }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Authorization failed", description: r.error.message });
      return;
    }
    setDecision("approved");
    window.location.assign(buildApproveRedirect(params.redirectUri, r.data.code, params.state));
  };

  const deny = () => {
    setDecision("denied");
    window.location.assign(buildDenyRedirect(params.redirectUri, params.state));
  };

  return (
    <Centered>
      <Card className="w-full">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Bot className="h-5 w-5" />
            <span className="text-sm font-medium">MCP client authorization</span>
          </div>
          <CardTitle className="text-xl">
            <span className="font-semibold">{presentation.name}</span> wants to connect to Orun
            Cloud
            {presentation.badgeLabel && (
              <Badge variant="warning" className="ml-2 align-middle">
                <AlertTriangle className="h-3 w-3" />
                {presentation.badgeLabel}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>
            Approving lets <span className="font-medium">{presentation.name}</span> read and act as
            you across all your workspaces — the same access as your account, like a CLI login.
            Tokens expire and refresh automatically; you can revoke this grant anytime in Account
            &rarr; Sessions &amp; devices.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {presentation.unverified && (
            <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-soft p-3 text-sm text-warning">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This app registered itself automatically and has not been reviewed by Orun Cloud.
                Its name is self-reported — only approve if you initiated this connection.
              </span>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{params.clientId}</Badge>
            {params.scope && <Badge variant="outline">scope: {params.scope}</Badge>}
            <span className="truncate font-mono">{params.redirectUri}</span>
          </div>

          {decision === "approved" ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted p-3 text-sm">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
              Approved. Returning you to {presentation.name}&hellip;
            </div>
          ) : decision === "denied" ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted p-3 text-sm">
              <ShieldX className="h-5 w-5 text-destructive" />
              Denied. Returning you to {presentation.name}&hellip;
            </div>
          ) : (
            <div className="flex gap-3">
              <Button onClick={approve} loading={busy} className="flex-1">
                Approve
              </Button>
              <Button onClick={deny} variant="outline" disabled={busy} className="flex-1">
                Deny
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </Centered>
  );
}

function InvalidRequest({ error }: { error: string }) {
  return (
    <Centered>
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Invalid authorization request</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-12">{children}</div>;
}
