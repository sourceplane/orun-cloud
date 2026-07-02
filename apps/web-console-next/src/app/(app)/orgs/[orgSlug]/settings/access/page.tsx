"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import type { FactOrigin } from "@saas/sdk";

export default function AccessPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function ProvenanceBadge({ via }: { via: FactOrigin | undefined }) {
  if (!via) return <span className="text-muted-foreground">—</span>;
  if (via.kind === "team") {
    return <Badge variant="default">via team {via.teamId ?? ""}</Badge>;
  }
  if (via.kind === "account_cascade") {
    return <Badge variant="secondary">account</Badge>;
  }
  return <Badge variant="outline">direct</Badge>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const access = useApiQuery(qk.effectiveAccess(orgId), () =>
    wrap(async () => (await client.teams.effectiveAccess(orgId)).permissions),
  );

  const allowed = React.useMemo(
    () => (access.data ?? []).filter((p) => p.allow),
    [access.data],
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Effective access</h1>
        <p className="text-sm text-muted-foreground">
          What you can do in this workspace, and how each permission reaches you — directly, through a team,
          or cascaded from the account.
        </p>
      </header>

      {access.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : access.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{access.error.code}</CardTitle>
            <CardDescription>{access.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : allowed.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No permissions here"
          description="You have no granted actions in this workspace yet."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Granted via</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allowed.map((p) => (
                <TableRow key={p.action}>
                  <TableCell className="font-mono text-xs">{p.action}</TableCell>
                  <TableCell><ProvenanceBadge via={p.via} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
