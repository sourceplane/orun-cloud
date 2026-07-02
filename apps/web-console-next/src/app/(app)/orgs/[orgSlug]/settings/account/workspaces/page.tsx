"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Boxes } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";

export default function AccountWorkspacesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const workspaces = useApiQuery(qk.accountWorkspaces(orgId), () =>
    wrap(async () => (await client.account.workspaces(orgId)).workspaces),
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Workspaces</h1>
        <p className="text-sm text-muted-foreground">
          Every workspace under this account. Teams and account roles reach all of them.
        </p>
      </header>

      {workspaces.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : workspaces.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{workspaces.error.code}</CardTitle>
            <CardDescription>{workspaces.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !workspaces.data || workspaces.data.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No child workspaces"
          description="This account has no child workspaces yet. New workspaces created under it will appear here."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Workspace ID</TableHead>
                <TableHead>Org ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workspaces.data.map((w) => (
                <TableRow key={w.orgId}>
                  <TableCell className="font-medium">{w.name}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{w.workspaceRef}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{w.orgId}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
