"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Plus, ShieldCheck } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { ACCOUNT_ROLES } from "@saas/contracts/membership";

export default function AccountRolesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} />}</OrgScope>;
}

function Inner({ orgId }: { orgId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [subjectId, setSubjectId] = React.useState("");
  const [role, setRole] = React.useState<string>("account_admin");
  const [busy, setBusy] = React.useState(false);
  const [pendingRevoke, setPendingRevoke] = React.useState<{ subjectId: string; role: string } | null>(null);

  const roles = useApiQuery(qk.accountRoles(orgId), () =>
    wrap(async () => (await client.account.roles(orgId)).assignments),
  );

  const grant = async () => {
    if (!subjectId.trim()) {
      toast({ kind: "error", title: "Enter a subject id" });
      return;
    }
    setBusy(true);
    const r = await wrap(() => client.account.grantRole(orgId, { subjectId: subjectId.trim(), role }));
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Grant failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Account role granted" });
    setOpen(false);
    setSubjectId("");
    roles.reload();
  };

  const revoke = async (target: { subjectId: string; role: string }) => {
    const r = await wrap(() => client.account.revokeRole(orgId, target));
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Account role revoked" });
    roles.reload();
  };

  return (
    <div className="space-y-5">
      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(o) => !o && setPendingRevoke(null)}
        title="Revoke account role"
        description="The subject loses this account-wide authority on every workspace under the account. Access they hold directly or through teams is unaffected."
        resourceName={pendingRevoke ? `${pendingRevoke.role} — ${pendingRevoke.subjectId}` : undefined}
        confirmLabel="Revoke role"
        onConfirm={() => (pendingRevoke ? revoke(pendingRevoke) : undefined)}
      />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Account roles</h1>
          <p className="text-sm text-muted-foreground">
            Account-wide authority. A role granted here cascades to every workspace under the account,
            current and future. Team grants at account scope are listed too; revoke those from the team.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1.5 size-4" /> Grant role
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Grant account role</DialogTitle>
              <DialogDescription>
                The subject gains this authority on every workspace under the account.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="account-role-subject">Subject id</Label>
                <Input
                  id="account-role-subject"
                  placeholder="usr_…"
                  value={subjectId}
                  onChange={(e) => setSubjectId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACCOUNT_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>{r}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
                <Button onClick={grant} disabled={busy}>Grant role</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </header>

      {roles.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : roles.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{roles.error.code}</CardTitle>
            <CardDescription>{roles.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !roles.data || roles.data.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No account roles"
          description="No one holds account-wide authority yet. Grant a role to give someone reach across every workspace."
          primaryAction={{ label: "Grant role", onClick: () => setOpen(true) }}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Subject</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Since</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {roles.data.map((a) => (
                <TableRow key={`${a.subjectId}-${a.role}`}>
                  <TableCell className="font-mono text-xs">{a.subjectId}</TableCell>
                  <TableCell>
                    <Badge variant={a.subjectType === "team" ? "secondary" : "outline"}>{a.subjectType}</Badge>
                  </TableCell>
                  <TableCell className="font-medium">{a.role}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(a.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    {a.subjectType === "user" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setPendingRevoke({ subjectId: a.subjectId, role: a.role })}
                      >
                        Revoke
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">via team</span>
                    )}
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
