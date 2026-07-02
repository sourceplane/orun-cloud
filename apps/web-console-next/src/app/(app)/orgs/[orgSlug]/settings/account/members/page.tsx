"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Users } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import type { AccountMemberOrigin } from "@saas/contracts/membership";

function OriginBadge({ origin }: { origin: AccountMemberOrigin }) {
  if (origin === "account_role") {
    // The cascade admins the roster exists to surface: authority everywhere,
    // membership nowhere.
    return <Badge variant="warning">account role only</Badge>;
  }
  if (origin === "both") {
    return <Badge variant="default">member + account role</Badge>;
  }
  return <Badge variant="outline">member</Badge>;
}

export default function AccountMembersPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const members = useApiQuery(qk.accountMembers(orgId), () =>
    wrap(async () => (await client.account.members(orgId)).members),
  );

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Account members</h1>
        <p className="text-sm text-muted-foreground">
          Everyone with account-level presence: members of the account root, plus holders of account-wide
          roles — including admins who appear in no workspace member list.
        </p>
      </header>

      {members.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : members.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{members.error.code}</CardTitle>
            <CardDescription>{members.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !members.data || members.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No account members"
          description="No one holds account-level membership or an account role yet."
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Presence</TableHead>
                <TableHead>Account roles</TableHead>
                <TableHead>Joined</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.data.map((m) => (
                <TableRow key={m.subjectId}>
                  <TableCell className="font-mono text-xs">{m.subjectId}</TableCell>
                  <TableCell><OriginBadge origin={m.origin} /></TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.accountRoles.length > 0 ? m.accountRoles.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
