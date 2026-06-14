"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Terminal, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { wrap } from "@/lib/api";

/**
 * CLI approval page (saas-orun-platform OP1).
 *
 * The Orun CLI's browser-loopback flow opens `/cli/approve?grant=<grantId>`.
 * The user (already authenticated in the console) confirms "Orun CLI on <host>
 * wants access" and approves or denies the single-use grant. Approving lets the
 * CLI redeem the grant for a session; denying invalidates it.
 */
export default function CliApprovePage() {
  const params = useSearchParams();
  const grantId = params?.get("grant") ?? "";
  const { client } = useSession();
  const { toast } = useToast();
  const [decision, setDecision] = React.useState<"approved" | "denied" | null>(null);
  const [busy, setBusy] = React.useState(false);

  const grant = useApiQuery(
    qk.cliGrant(grantId),
    () => wrap(async () => (await client.cliSessions.getGrant(grantId)).grant),
    { enabled: !!grantId },
  );

  const approve = async () => {
    setBusy(true);
    const r = await wrap(() => client.cliSessions.approveGrant(grantId));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Approval failed", description: r.error.message });
      return;
    }
    setDecision("approved");
  };

  const deny = async () => {
    setBusy(true);
    const r = await wrap(() => client.cliSessions.denyGrant(grantId));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Could not deny", description: r.error.message });
      return;
    }
    setDecision("denied");
  };

  if (!grantId) {
    return (
      <Centered>
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">Missing login request</CardTitle>
            <CardDescription>
              This page expects a CLI login link. Re-run <span className="font-mono">orun auth login</span>.
            </CardDescription>
          </CardHeader>
        </Card>
      </Centered>
    );
  }

  return (
    <Centered>
      <Card className="w-full">
        <CardHeader className="space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Terminal className="h-5 w-5" />
            <span className="text-sm font-medium">Orun CLI</span>
          </div>
          {grant.loading ? (
            <Skeleton className="h-7 w-2/3" />
          ) : grant.error ? (
            <CardTitle className="text-destructive">{grant.error.message}</CardTitle>
          ) : (
            <CardTitle className="text-xl">
              Orun CLI on{" "}
              <span className="font-mono">{grant.data?.host ?? "an unknown device"}</span> wants access
            </CardTitle>
          )}
          {!grant.loading && !grant.error && grant.data && (
            <CardDescription>
              Approving signs the Orun CLI into your account on this device. It will be able to act
              as you within your organizations until you revoke it in Settings &rarr; Sessions &amp;
              devices.
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {!grant.loading && !grant.error && grant.data && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{grant.data.flow === "device" ? "device flow" : "browser"}</Badge>
              <span>expires {new Date(grant.data.expiresAt).toLocaleTimeString()}</span>
            </div>
          )}

          {decision === "approved" ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted p-3 text-sm">
              <ShieldCheck className="h-5 w-5 text-emerald-500" />
              Approved. Return to your terminal — the CLI should finish signing in.
            </div>
          ) : decision === "denied" ? (
            <div className="flex items-center gap-2 rounded-md border bg-muted p-3 text-sm">
              <ShieldX className="h-5 w-5 text-destructive" />
              Denied. The CLI login request was rejected.
            </div>
          ) : (
            !grant.loading &&
            !grant.error &&
            grant.data &&
            grant.data.status === "pending" && (
              <div className="flex gap-3">
                <Button onClick={approve} loading={busy} className="flex-1">
                  Approve
                </Button>
                <Button onClick={deny} variant="outline" loading={busy} className="flex-1">
                  Deny
                </Button>
              </div>
            )
          )}

          {!grant.loading && !grant.error && grant.data && grant.data.status !== "pending" && !decision && (
            <div className="rounded-md border bg-muted p-3 text-sm text-muted-foreground">
              This login request is{" "}
              <span className="font-medium">{grant.data.status}</span> and can no longer be approved.
            </div>
          )}
        </CardContent>
      </Card>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex max-w-md flex-col gap-4 px-4 py-12">{children}</div>;
}
