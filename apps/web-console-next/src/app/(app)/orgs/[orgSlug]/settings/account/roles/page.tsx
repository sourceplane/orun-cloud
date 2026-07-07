"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Plus, ShieldCheck } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
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
import { SettingsHeader, SettingsPanel } from "@/components/settings/settings-primitives";
import { ListCard, ListRow, Pill } from "@/components/ui/northwind";
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
    <div className="space-y-[18px]">
      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(o) => !o && setPendingRevoke(null)}
        title="Revoke account role"
        description="The subject loses this account-wide authority on every workspace under the account. Access they hold directly or through teams is unaffected."
        resourceName={pendingRevoke ? `${pendingRevoke.role} — ${pendingRevoke.subjectId}` : undefined}
        confirmLabel="Revoke role"
        onConfirm={() => (pendingRevoke ? revoke(pendingRevoke) : undefined)}
      />
      <SettingsHeader
        title="Account roles"
        description="Account-wide authority. A role granted here cascades to every workspace under the account, current and future. Team grants at account scope are listed too; revoke those from the team."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1.5 size-4" strokeWidth={1.8} /> Grant role
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
        }
      />

      {roles.loading ? (
        <SettingsPanel className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </SettingsPanel>
      ) : roles.error ? (
        <SettingsPanel>
          <div className="text-[13.5px] font-semibold text-destructive">{roles.error.code}</div>
          <p className="mt-1.5 text-[12.5px] text-muted-foreground">{roles.error.message}</p>
        </SettingsPanel>
      ) : !roles.data || roles.data.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="No account roles"
          description="No one holds account-wide authority yet. Grant a role to give someone reach across every workspace."
          primaryAction={{ label: "Grant role", onClick: () => setOpen(true) }}
        />
      ) : (
        <ListCard>
          {roles.data.map((a) => (
            <ListRow key={`${a.subjectId}-${a.role}`} className="items-start">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-mono text-xs">{a.subjectId}</span>
                  <Pill tone={a.subjectType === "team" ? "info" : "neutral"}>{a.subjectType}</Pill>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
                  <span className="text-[13px] font-medium text-foreground">{a.role}</span>
                  <span>since {new Date(a.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              {a.subjectType === "user" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  onClick={() => setPendingRevoke({ subjectId: a.subjectId, role: a.role })}
                >
                  Revoke
                </Button>
              ) : (
                <span className="shrink-0 text-[11.5px] text-muted-foreground">via team</span>
              )}
            </ListRow>
          ))}
        </ListCard>
      )}
    </div>
  );
}
