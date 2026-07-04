"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, usePathname, useSearchParams } from "next/navigation";
import { z } from "zod";
import { Activity, ArrowLeft, Boxes, Pencil, Plus, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { wrap } from "@/lib/api";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { TeamAvatar } from "@/components/teams/team-avatar";
import { ACCOUNT_ROLES, ORGANIZATION_ROLES } from "@saas/contracts/membership";
import type { TeamGrant } from "@saas/contracts/membership";

const TABS = ["overview", "members", "access", "ownership", "activity"] as const;
type TabKey = (typeof TABS)[number];

export default function TeamPage() {
  const params = useParams<{ orgSlug: string; teamId: string }>();
  const slug = params?.orgSlug ?? "";
  const teamId = params?.teamId ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} slug={slug} teamId={teamId} />}</OrgScope>;
}

function LoadingCard({ rows = 3 }: { rows?: number }) {
  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

function StatChip({ icon: Icon, value, label }: { icon: typeof Users; value: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[12px] text-muted-foreground">
      <Icon className="size-3.5 opacity-70" />
      <span className="font-medium tabular-nums text-foreground">{value}</span>
      {label}
    </span>
  );
}

function Inner({ orgId, slug, teamId }: { orgId: string; slug: string; teamId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL-synced tab so a team view is linkable (Datadog-style).
  const tabParam = searchParams?.get("tab");
  const tab: TabKey = (TABS as readonly string[]).includes(tabParam ?? "") ? (tabParam as TabKey) : "overview";
  const setTab = (t: string) => {
    const q = new URLSearchParams(searchParams?.toString());
    if (t === "overview") q.delete("tab");
    else q.set("tab", t);
    router.replace(`${pathname}${q.toString() ? `?${q}` : ""}`, { scroll: false });
  };

  const team = useApiQuery(qk.team(orgId, teamId), () =>
    wrap(async () => (await client.teams.getTeam(orgId, teamId)).team),
  );
  const members = useApiQuery(qk.teamMembers(orgId, teamId), () =>
    wrap(async () => (await client.teams.listTeamMembers(orgId, teamId)).members),
  );
  const grants = useApiQuery(qk.teamGrants(orgId, teamId), () =>
    wrap(async () => (await client.teams.listTeamGrants(orgId, teamId)).grants),
  );
  const ownerHandles = useApiQuery(qk.ownerHandles(orgId), () =>
    wrap(async () => (await client.teams.listOwnerHandles(orgId)).ownerHandles),
  );
  const catalog = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() => collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query))),
  );
  const ownerStrings = React.useMemo(
    () => [...new Set((catalog.data ?? []).map((e) => e.owner).filter((o): o is string => !!o))],
    [catalog.data],
  );
  const ownerResolutions = useApiQuery(["ownerResolutions", orgId, ownerStrings.join("\n")] as const, () =>
    wrap(async () => (await client.teams.resolveOwners(orgId, { owners: ownerStrings })).resolutions),
  );
  // The catalog entities this team owns (resolved) — for the count + the list.
  const ownedServices = React.useMemo(() => {
    const byOwner = new Map((ownerResolutions.data ?? []).map((r) => [r.owner, r]));
    return (catalog.data ?? [])
      .filter((e) => {
        if (!e.owner) return false;
        const r = byOwner.get(e.owner);
        return r && r.state === "owned" && r.teamId === teamId;
      })
      .map((e) => ({ ref: e.entityRef, name: e.name || e.entityRef, kind: e.kind, project: e.sourceProjectId }));
  }, [catalog.data, ownerResolutions.data, teamId]);
  const ownedCount = ownedServices.length;
  const workspaces = useApiQuery(qk.accountWorkspaces(orgId), () =>
    wrap(async () => (await client.account.workspaces(orgId)).workspaces),
  );
  const activity = useApiQuery(qk.accountRuns(orgId), () =>
    wrap(async () => await client.account.runs(orgId, { limit: 10 })),
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
  const [memberRole, setMemberRole] = React.useState("team_member");
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
        ...(memberRole !== "team_member" ? { teamRole: memberRole } : {}),
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
    setMemberRole("team_member");
    members.reload();
  };
  const changeMemberRole = async (subject: string, teamRole: string) => {
    const r = await wrap(() => client.teams.updateTeamMemberRole(orgId, teamId, subject, { teamRole }));
    if (!r.ok) {
      toast({ kind: "error", title: "Role change failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: teamRole === "team_admin" ? "Promoted to team admin" : "Set to team member" });
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
  const [targetOrgs, setTargetOrgs] = React.useState<Set<string>>(() => new Set([orgId]));
  const [pendingRevoke, setPendingRevoke] = React.useState<TeamGrant | null>(null);
  const rolesForScope = scope === "account" ? ACCOUNT_ROLES : ORGANIZATION_ROLES;
  const toggleTargetOrg = (id: string) =>
    setTargetOrgs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const grantRole = async () => {
    const targets = scope === "account" ? [orgId] : [...targetOrgs];
    if (targets.length === 0) {
      toast({ kind: "error", title: "Select at least one workspace" });
      return;
    }
    setBusy(true);
    let granted = 0;
    for (const target of targets) {
      const r = await wrap(() => client.teams.grantTeamRole(target, { teamId, role, scopeKind: scope }));
      if (r.ok) granted += 1;
      else toast({ kind: "error", title: `Grant failed for ${scope === "account" ? "account" : workspaceName(target)}`, description: r.error.message });
    }
    setBusy(false);
    if (granted > 0) {
      toast({ kind: "success", title: scope === "account" ? "Role granted account-wide" : `Role granted on ${granted} workspace${granted === 1 ? "" : "s"}` });
      setGrantOpen(false);
      grants.reload();
    }
  };
  const revokeGrant = async (g: TeamGrant) => {
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

  // ── owner-alias state (TO1) ──
  const [aliasInput, setAliasInput] = React.useState("");
  const teamAliases = React.useMemo(
    () => (ownerHandles.data ?? []).filter((h) => h.teamId === teamId),
    [ownerHandles.data, teamId],
  );
  const addAlias = async () => {
    const handle = aliasInput.trim();
    if (!handle) {
      toast({ kind: "error", title: "Enter an owner string" });
      return;
    }
    const r = await wrap(() => client.teams.setOwnerHandle(orgId, { ownerHandle: handle, teamId }));
    if (!r.ok) {
      toast({ kind: "error", title: "Alias failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Owner alias set" });
    setAliasInput("");
    ownerHandles.reload();
  };
  const removeAlias = async (handle: string) => {
    const r = await wrap(() => client.teams.deleteOwnerHandle(orgId, handle));
    if (!r.ok) {
      toast({ kind: "error", title: "Remove failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Owner alias removed" });
    ownerHandles.reload();
  };

  // ── team edit / delete ──
  const [editOpen, setEditOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState(false);
  const deleteTeam = async () => {
    const r = await wrap(() => client.teams.deleteTeam(orgId, teamId));
    if (!r.ok) {
      toast({ kind: "error", title: "Delete failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Team deleted" });
    router.push(`/orgs/${slug}/teams`);
  };

  const memberCount = members.data?.length ?? 0;
  const grantCount = grants.data?.length ?? 0;

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
      <ConfirmDialog
        open={pendingDelete}
        onOpenChange={setPendingDelete}
        title="Delete team"
        description="The team is removed and all of its role grants are revoked. Members lose any access they held through this team. Owner aliases are cleared."
        resourceName={team.data?.name}
        confirmLabel="Delete team"
        onConfirm={deleteTeam}
      />

      <Link href={`/orgs/${slug}/teams`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-3.5" /> Teams
      </Link>

      {/* ── Hero ── */}
      {team.loading ? (
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-xl" />
          <Skeleton className="h-10 w-64" />
        </div>
      ) : team.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{team.error.code}</CardTitle>
            <CardDescription>{team.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : team.data ? (
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-4">
            <TeamAvatar name={team.data.name} seed={team.data.handle ?? null} size={56} className="rounded-xl" />
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="truncate text-xl font-semibold tracking-tight">{team.data.name}</h1>
                {team.data.handle ? <span className="font-mono text-sm text-muted-foreground">@{team.data.handle}</span> : null}
                <Badge variant={team.data.status === "active" ? "default" : "secondary"}>{team.data.status}</Badge>
              </div>
              {team.data.description ? <p className="max-w-2xl text-sm text-muted-foreground">{team.data.description}</p> : null}
              <div className="flex flex-wrap gap-2 pt-1">
                <StatChip icon={Users} value={members.loading ? "—" : memberCount} label={memberCount === 1 ? "member" : "members"} />
                <StatChip icon={Boxes} value={ownedCount} label={ownedCount === 1 ? "owned service" : "owned services"} />
                <StatChip icon={ShieldCheck} value={grants.loading ? "—" : grantCount} label={grantCount === 1 ? "grant" : "grants"} />
              </div>
            </div>
          </div>
          <EditTeamButton
            open={editOpen}
            setOpen={setEditOpen}
            team={team.data}
            onSave={async (patch) => {
              const r = await wrap(() => client.teams.updateTeam(orgId, teamId, patch));
              if (!r.ok) {
                toast({ kind: "error", title: "Update failed", description: r.error.message });
                return false;
              }
              toast({ kind: "success", title: "Team updated" });
              setEditOpen(false);
              team.reload();
              return true;
            }}
          />
        </header>
      ) : null}

      {/* ── Tabs ── */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="members">Members{members.data ? ` · ${memberCount}` : ""}</TabsTrigger>
          <TabsTrigger value="access">Access{grants.data ? ` · ${grantCount}` : ""}</TabsTrigger>
          <TabsTrigger value="ownership">Ownership{ownedCount ? ` · ${ownedCount}` : ""}</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        {/* Overview */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <SummaryCard title="Members" icon={Users} count={memberCount} cta="Manage members" onClick={() => setTab("members")}
              blurb="Everyone on the team receives every role and every ownership the team holds." />
            <SummaryCard title="Access" icon={ShieldCheck} count={grantCount} cta="Manage access" onClick={() => setTab("access")}
              blurb="Roles this team is granted, account-wide or per workspace." />
            <SummaryCard title="Owned services" icon={Boxes} count={ownedCount} cta="View ownership" onClick={() => setTab("ownership")}
              blurb="Catalog entities whose git owner resolves to this team. Ownership is accountability, not access." />
            <SummaryCard title="Aliases" icon={Boxes} count={teamAliases.length} cta="View ownership" onClick={() => setTab("ownership")}
              blurb="Owner strings mapped to this team beyond its handle." />
          </div>
          <Card className="border-destructive/40">
            <CardHeader>
              <CardTitle className="text-base">Danger zone</CardTitle>
              <CardDescription>Deleting a team revokes its grants and clears its ownership. This cannot be undone.</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" size="sm" onClick={() => setPendingDelete(true)}>
                <Trash2 className="mr-1.5 size-4" /> Delete team
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Members */}
        <TabsContent value="members" className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Users and service principals. A <code>team_admin</code> can manage the roster; grants stay with account/workspace admins.</p>
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><UserPlus className="mr-1.5 size-4" /> Add member</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add team member</DialogTitle>
                  <DialogDescription>Users and service principals can join a team.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="team-member-subject">Subject id</Label>
                    <Input id="team-member-subject" placeholder="usr_…" value={subjectId} onChange={(e) => setSubjectId(e.target.value)} />
                  </div>
                  <div className="space-y-2">
                    <Label>Type</Label>
                    <Select value={subjectType} onValueChange={setSubjectType}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">user</SelectItem>
                        <SelectItem value="service_principal">service_principal</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Team role</Label>
                    <Select value={memberRole} onValueChange={setMemberRole}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="team_member">team_member — plain member</SelectItem>
                        <SelectItem value="team_admin">team_admin — manages the team + roster</SelectItem>
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
            <ErrorCard code={members.error.code} message={members.error.message} />
          ) : !members.data || members.data.length === 0 ? (
            <EmptyState icon={Users} title="No members yet" description="Add people to give them everything this team can do." primaryAction={{ label: "Add member", onClick: () => setAddOpen(true) }} />
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Team role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.data.map((m) => {
                    const isAdmin = (m.teamRole ?? "team_member") === "team_admin";
                    return (
                      <TableRow key={m.subjectId}>
                        <TableCell className="font-mono text-xs">{m.subjectId}</TableCell>
                        <TableCell className="text-muted-foreground">{m.subjectType}</TableCell>
                        <TableCell><Badge variant={isAdmin ? "default" : "secondary"}>{m.teamRole ?? "team_member"}</Badge></TableCell>
                        <TableCell><Badge variant={m.status === "active" ? "default" : "secondary"}>{m.status}</Badge></TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => changeMemberRole(m.subjectId, isAdmin ? "team_member" : "team_admin")}>
                            {isAdmin ? "Make member" : "Make admin"}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setPendingRemove(m.subjectId)}>Remove</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* Access */}
        <TabsContent value="access" className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">What this team can do, and where — account-wide or per workspace.</p>
            <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
              <DialogTrigger asChild>
                <Button size="sm"><Plus className="mr-1.5 size-4" /> Grant role</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Grant the team a role</DialogTitle>
                  <DialogDescription>Account scope reaches every workspace, current and future. Workspace scope targets one.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Scope</Label>
                    <Select value={scope} onValueChange={(v) => setScope(v as "account" | "organization")}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="organization">workspace</SelectItem>
                        <SelectItem value="account">account (all workspaces)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {scope === "organization" ? (
                    <div className="space-y-2">
                      <Label>Workspaces</Label>
                      <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                        <label className="flex items-center gap-2 text-sm">
                          <Checkbox checked={targetOrgs.has(orgId)} onCheckedChange={() => toggleTargetOrg(orgId)} />
                          this workspace
                        </label>
                        {(workspaces.data ?? []).filter((w) => w.orgId !== orgId).map((w) => (
                          <label key={w.orgId} className="flex items-center gap-2 text-sm">
                            <Checkbox checked={targetOrgs.has(w.orgId)} onCheckedChange={() => toggleTargetOrg(w.orgId)} />
                            {w.name}
                          </label>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">One grant per selected workspace. For everything — including workspaces created later — use account scope instead.</p>
                    </div>
                  ) : null}
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <Select value={role} onValueChange={setRole}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>{rolesForScope.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
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
            <ErrorCard code={grants.error.code} message={grants.error.message} />
          ) : !grants.data || grants.data.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="No grants yet" description="Grant the team a role to give every member access in one move." primaryAction={{ label: "Grant role", onClick: () => setGrantOpen(true) }} />
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
                        {g.scopeKind === "account" ? "every workspace" : g.scopeKind === "project" ? `project ${g.scopeRef ?? ""} · ${workspaceName(g.orgId)}` : workspaceName(g.orgId)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setPendingRevoke(g)}>Revoke</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* Ownership */}
        <TabsContent value="ownership" className="space-y-5">
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">Owned services</h2>
              <p className="text-sm text-muted-foreground">Catalog entities whose git <code>owner:</code> resolves to this team. Read-time — the catalog is never rewritten.</p>
            </div>
            {ownedServices.length === 0 ? (
              <EmptyState icon={Boxes} title="No owned services yet" description="Set an entity's owner to this team's handle in git, or add an alias below." />
            ) : (
              <Card>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Entity</TableHead>
                      <TableHead>Kind</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ownedServices.map((s) => (
                      <TableRow key={s.ref}>
                        <TableCell className="font-medium">
                          <Link href={`/orgs/${slug}/catalog`} className="hover:underline">{s.name}</Link>
                          <span className="ml-2 font-mono text-[11px] text-muted-foreground">{s.ref}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{s.kind}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            )}
          </section>
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold">Owner aliases</h2>
              <p className="text-sm text-muted-foreground">
                Extra git <code>owner:</code> strings that resolve to this team. By default an entity whose owner matches the handle is already owned — add an alias only for legacy or differently-spelled strings.
              </p>
            </div>
            <Card>
              <CardContent className="space-y-3 pt-6">
                <div className="flex gap-2">
                  <Input placeholder="owner string, e.g. group:payments or legacy-payments" value={aliasInput} onChange={(e) => setAliasInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addAlias()} />
                  <Button onClick={addAlias}>Add alias</Button>
                </div>
                {ownerHandles.loading ? (
                  <Skeleton className="h-9 w-full" />
                ) : teamAliases.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No aliases — this team is resolved by its handle.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Owner string</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {teamAliases.map((h) => (
                        <TableRow key={h.ownerHandle}>
                          <TableCell className="font-mono text-xs">{h.ownerHandle}</TableCell>
                          <TableCell className="text-right">
                            <Button variant="ghost" size="sm" onClick={() => removeAlias(h.ownerHandle)}>Remove</Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </section>
        </TabsContent>

        {/* Activity */}
        <TabsContent value="activity" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Recent runs across the workspaces this account spans{activity.data?.truncated ? " (largest accounts truncated to the first 20 workspaces)" : ""}.
          </p>
          {activity.loading ? (
            <LoadingCard rows={4} />
          ) : activity.error || !activity.data || activityRows(activity.data).length === 0 ? (
            <EmptyState icon={Activity} title="No recent activity" description="Runs in workspaces you can read will show up here." />
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Workspace</TableHead>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Environment</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activityRows(activity.data).map((r) => (
                    <TableRow key={`${r.workspace}-${r.runId}`}>
                      <TableCell className="text-muted-foreground">{r.workspace}</TableCell>
                      <TableCell className="font-mono text-xs">{r.runId}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "succeeded" ? "success" : r.status === "failed" ? "destructive" : r.status === "running" ? "default" : "secondary"}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.environment ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ErrorCard({ code, message }: { code: string; message: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-destructive">{code}</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function SummaryCard({ title, icon: Icon, count, blurb, cta, onClick }: { title: string; icon: typeof Users; count: number; blurb: string; cta: string; onClick: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 pt-6">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          <span className="text-sm font-medium text-foreground">{title}</span>
          <span className="ml-auto text-2xl font-semibold tabular-nums text-foreground">{count}</span>
        </div>
        <p className="text-sm text-muted-foreground">{blurb}</p>
        <button type="button" onClick={onClick} className="mt-1 self-start text-sm font-medium text-primary hover:underline">
          {cta} →
        </button>
      </CardContent>
    </Card>
  );
}

const editSchema = z.object({
  name: z.string().min(1, "Enter a team name"),
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, "2–39 chars: lower-case letters, digits, hyphens; no leading hyphen").optional().or(z.literal("")),
  description: z.string().max(500, "At most 500 characters").optional(),
});

function EditTeamButton({
  open,
  setOpen,
  team,
  onSave,
}: {
  open: boolean;
  setOpen: (o: boolean) => void;
  team: { name: string; handle?: string | null; description?: string | null };
  onSave: (patch: { name?: string; handle?: string; description?: string }) => Promise<boolean>;
}) {
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Pencil className="mr-1.5 size-4" /> Edit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit team</DialogTitle>
          <DialogDescription>The team id never changes — a rename keeps every grant and ownership intact.</DialogDescription>
        </DialogHeader>
        <ZodForm
          schema={editSchema}
          defaultValues={{ name: team.name, handle: team.handle ?? "", description: team.description ?? "" }}
          fields={[
            { name: "name", label: "Name" },
            { name: "handle", label: "Handle", hint: "Mentionable @handle" },
            { name: "description", label: "Description" },
          ]}
          submitLabel="Save changes"
          cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
          onSubmit={async (v) => {
            await onSave({
              name: v.name,
              ...(v.handle ? { handle: v.handle } : {}),
              ...(v.description !== undefined ? { description: v.description } : {}),
            });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Flatten the per-workspace fan-out into one newest-first list, capped for the card. */
function activityRows(data: import("@saas/contracts/state").AccountRunsResponse): Array<{
  workspace: string;
  runId: string;
  status: string;
  environment: string | null;
  createdAt: string;
}> {
  return data.workspaces
    .filter((w) => w.status === "ok")
    .flatMap((w) =>
      w.runs.map((run) => ({
        workspace: w.workspace.name || w.workspace.workspaceRef,
        runId: run.runId,
        status: run.status,
        environment: run.environment,
        createdAt: run.createdAt,
      })),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 10);
}
