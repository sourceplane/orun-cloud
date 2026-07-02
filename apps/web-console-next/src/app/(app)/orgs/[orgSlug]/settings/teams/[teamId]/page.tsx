"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Plus, ShieldCheck, UserPlus, Users } from "lucide-react";
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
import { ACCOUNT_ROLES, ORGANIZATION_ROLES } from "@saas/contracts/membership";
import type { TeamGrant } from "@saas/contracts/membership";

export default function TeamPage() {
  const params = useParams<{ orgSlug: string; teamId: string }>();
  const slug = params?.orgSlug ?? "";
  const teamId = params?.teamId ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} slug={slug} teamId={teamId} />}</OrgScope>;
}

function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <Card>
      <CardContent className="pt-6 space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

function Inner({ orgId, slug, teamId }: { orgId: string; slug: string; teamId: string }) {
  const { client } = useSession();
  const { toast } = useToast();

  const team = useApiQuery(qk.team(orgId, teamId), () =>
    wrap(async () => (await client.teams.getTeam(orgId, teamId)).team),
  );
  const members = useApiQuery(qk.teamMembers(orgId, teamId), () =>
    wrap(async () => (await client.teams.listTeamMembers(orgId, teamId)).members),
  );
  const grants = useApiQuery(qk.teamGrants(orgId, teamId), () =>
    wrap(async () => (await client.teams.listTeamGrants(orgId, teamId)).grants),
  );
  const workspaces = useApiQuery(qk.accountWorkspaces(orgId), () =>
    wrap(async () => (await client.account.workspaces(orgId)).workspaces),
  );

  const workspaceName = React.useCallback(
    (targetOrgId: string): string => {
      if (targetOrgId === orgId) return "this workspace";
      const w = (workspaces.data ?? []).find((x) => x.orgId === targetOrgId);
      return w ? w.name : targetOrgId;
    },
    [orgId, workspaces.data],
  );

  // ── members state ──
  const [addOpen, setAddOpen] = React.useState(false);
  const [subjectId, setSubjectId] = React.useState("");
  const [subjectType, setSubjectType] = React.useState("user");
  const [busy, setBusy] = React.useState(false);
  const [pendingRemove, setPendingRemove] = React.useState<string | null>(null);

  const addMember = async () => {
    if (!subjectId.trim()) {
      toast({ kind: "error", title: "Enter a subject id" });
      return;
    }
    setBusy(true);
    const r = await wrap(() =>
      client.teams.addTeamMember(orgId, teamId, {
        subjectId: subjectId.trim(),
        ...(subjectType !== "user" ? { subjectType } : {}),
      }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Add failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Member added" });
    setAddOpen(false);
    setSubjectId("");
    members.reload();
  };

  const removeMember = async (subject: string) => {
    const r = await wrap(() => client.teams.removeTeamMember(orgId, teamId, subject));
    if (!r.ok) {
      toast({ kind: "error", title: "Remove failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Member removed" });
    members.reload();
  };

  // ── grants state ──
  const [grantOpen, setGrantOpen] = React.useState(false);
  const [scope, setScope] = React.useState<"account" | "organization">("organization");
  const [role, setRole] = React.useState("builder");
  const [targetOrg, setTargetOrg] = React.useState(orgId);
  const [pendingRevoke, setPendingRevoke] = React.useState<TeamGrant | null>(null);

  const rolesForScope = scope === "account" ? ACCOUNT_ROLES : ORGANIZATION_ROLES;

  const grantRole = async () => {
    setBusy(true);
    // The grant is written on its authority org: the account for account scope
    // (any org path resolves up), the TARGET workspace for organization scope.
    const pathOrg = scope === "account" ? orgId : targetOrg;
    const r = await wrap(() =>
      client.teams.grantTeamRole(pathOrg, { teamId, role, scopeKind: scope }),
    );
    setBusy(false);
    if (!r.ok) {
      toast({ kind: "error", title: "Grant failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Role granted" });
    setGrantOpen(false);
    grants.reload();
  };

  const revokeGrant = async (g: TeamGrant) => {
    // Revokes address the grant's own org (its authority org) — for a
    // workspace-scoped grant on another workspace that is the target org.
    const r = await wrap(() =>
      client.teams.revokeTeamRole(g.orgId, {
        teamId,
        role: g.role,
        scopeKind: g.scopeKind as "account" | "organization" | "project",
        ...(g.scopeRef ? { scopeRef: g.scopeRef } : {}),
      }),
    );
    if (!r.ok) {
      toast({ kind: "error", title: "Revoke failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Grant revoked" });
    grants.reload();
  };

  React.useEffect(() => {
    setRole(scope === "account" ? "account_admin" : "builder");
  }, [scope]);

  return (
    <div className="space-y-5">
      <ConfirmDialog
        open={pendingRemove !== null}
        onOpenChange={(o) => !o && setPendingRemove(null)}
        title="Remove member"
        description="The subject leaves the team and loses any access they held through it."
        resourceName={pendingRemove ?? undefined}
        confirmLabel="Remove"
        onConfirm={() => (pendingRemove ? removeMember(pendingRemove) : undefined)}
      />
      <ConfirmDialog
        open={pendingRevoke !== null}
        onOpenChange={(o) => !o && setPendingRevoke(null)}
        title="Revoke grant"
        description="Every member of the team loses this access."
        resourceName={pendingRevoke ? `${pendingRevoke.role} @ ${pendingRevoke.scopeKind === "account" ? "account" : workspaceName(pendingRevoke.orgId)}` : undefined}
        confirmLabel="Revoke"
        onConfirm={() => (pendingRevoke ? revokeGrant(pendingRevoke) : undefined)}
      />

      <div>
        <Link
          href={`/orgs/${slug}/settings/teams`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> Teams
        </Link>
      </div>

      {team.loading ? (
        <Skeleton className="h-10 w-64" />
      ) : team.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{team.error.code}</CardTitle>
            <CardDescription>{team.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : team.data ? (
        <header className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{team.data.name}</h1>
          <Badge variant="outline" className="font-mono text-xs">@{team.data.slug}</Badge>
          <Badge variant={team.data.status === "active" ? "default" : "secondary"}>{team.data.status}</Badge>
        </header>
      ) : null}

      {/* ── Members ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Members</h2>
            <p className="text-sm text-muted-foreground">Everyone on the team receives every role the team holds.</p>
          </div>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <UserPlus className="mr-1.5 size-4" /> Add member
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add team member</DialogTitle>
                <DialogDescription>Users and service principals can join a team.</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="team-member-subject">Subject id</Label>
                  <Input
                    id="team-member-subject"
                    placeholder="usr_…"
                    value={subjectId}
                    onChange={(e) => setSubjectId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Type</Label>
                  <Select value={subjectType} onValueChange={setSubjectType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="user">user</SelectItem>
                      <SelectItem value="service_principal">service_principal</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setAddOpen(false)} disabled={busy}>Cancel</Button>
                  <Button onClick={addMember} disabled={busy}>Add member</Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {members.loading ? (
          <LoadingCard />
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
            title="No members yet"
            description="Add people to give them everything this team can do."
            primaryAction={{ label: "Add member", onClick: () => setAddOpen(true) }}
          />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Subject</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.data.map((m) => (
                  <TableRow key={m.subjectId}>
                    <TableCell className="font-mono text-xs">{m.subjectId}</TableCell>
                    <TableCell className="text-muted-foreground">{m.subjectType}</TableCell>
                    <TableCell>
                      <Badge variant={m.status === "active" ? "default" : "secondary"}>{m.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setPendingRemove(m.subjectId)}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      {/* ── Access ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Access</h2>
            <p className="text-sm text-muted-foreground">
              What this team can do, and where — account-wide or per workspace.
            </p>
          </div>
          <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="mr-1.5 size-4" /> Grant role
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Grant the team a role</DialogTitle>
                <DialogDescription>
                  Account scope reaches every workspace, current and future. Workspace scope targets one.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>Scope</Label>
                  <Select value={scope} onValueChange={(v) => setScope(v as "account" | "organization")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="organization">workspace</SelectItem>
                      <SelectItem value="account">account (all workspaces)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {scope === "organization" ? (
                  <div className="space-y-2">
                    <Label>Workspace</Label>
                    <Select value={targetOrg} onValueChange={setTargetOrg}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={orgId}>this workspace</SelectItem>
                        {(workspaces.data ?? [])
                          .filter((w) => w.orgId !== orgId)
                          .map((w) => (
                            <SelectItem key={w.orgId} value={w.orgId}>{w.name}</SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
                <div className="space-y-2">
                  <Label>Role</Label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {rolesForScope.map((r) => (
                        <SelectItem key={r} value={r}>{r}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => setGrantOpen(false)} disabled={busy}>Cancel</Button>
                  <Button onClick={grantRole} disabled={busy}>Grant role</Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {grants.loading ? (
          <LoadingCard />
        ) : grants.error ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-destructive">{grants.error.code}</CardTitle>
              <CardDescription>{grants.error.message}</CardDescription>
            </CardHeader>
          </Card>
        ) : !grants.data || grants.data.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No grants yet"
            description="Grant the team a role to give every member access in one move."
            primaryAction={{ label: "Grant role", onClick: () => setGrantOpen(true) }}
          />
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Role</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Where</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.data.map((g) => (
                  <TableRow key={`${g.orgId}-${g.role}-${g.scopeKind}-${g.scopeRef ?? ""}`}>
                    <TableCell className="font-medium">{g.role}</TableCell>
                    <TableCell>
                      <Badge variant={g.scopeKind === "account" ? "secondary" : "outline"}>
                        {g.scopeKind === "account" ? "account (all workspaces)" : g.scopeKind}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {g.scopeKind === "account"
                        ? "every workspace"
                        : g.scopeKind === "project"
                          ? `project ${g.scopeRef ?? ""} · ${workspaceName(g.orgId)}`
                          : workspaceName(g.orgId)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => setPendingRevoke(g)}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}
