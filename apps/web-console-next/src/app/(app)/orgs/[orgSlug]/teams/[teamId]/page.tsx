"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { z } from "zod";
import { MoreHorizontal, X } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ZodForm } from "@/components/ui/zod-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Breadcrumbs,
  Kicker,
  ListCard,
  ListCardHeader,
  ListRow,
  OwnerAvatar,
  PersonAvatar,
  Pill,
  QuietLink,
  Screen,
  StatusDot,
  type Tone,
} from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import {
  annotateOwnership,
  healthOf,
  scorecardOf,
  tierOf,
  toServices,
} from "@/lib/catalog-portal/model";
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

function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 px-5 pb-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** Quiet in-card empty/notice row. */
function CardNote({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-border/50 px-5 py-4 text-[12.5px] text-muted-foreground/85">{children}</div>;
}

function Inner({ orgId, slug, teamId }: { orgId: string; slug: string; teamId: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const router = useRouter();

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
  // The catalog entities this team owns (resolved) — health, tier and SLO come
  // from the portal model so the numbers match the catalog everywhere.
  const ownedServices = React.useMemo(() => {
    const byOwner = new Map((ownerResolutions.data ?? []).map((r) => [r.owner, r]));
    return annotateOwnership(toServices(catalog.data ?? []), byOwner).filter(
      (s) => s.ownerState === "owned" && s.ownerTeam?.teamId === teamId,
    );
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

  // The strings the resolver maps to this team: the handle plus any aliases.
  const resolveStrings = React.useMemo(() => {
    const strings = [team.data?.handle, ...teamAliases.map((h) => h.ownerHandle)].filter(
      (s): s is string => !!s,
    );
    return strings;
  }, [team.data?.handle, teamAliases]);

  return (
    <Screen detail>
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

      <Breadcrumbs
        items={[
          { label: "Teams", href: `/orgs/${slug}/teams` },
          { label: team.data?.name ?? "…" },
        ]}
      />

      {/* ── Header ── */}
      {team.loading ? (
        <div className="flex items-center gap-4">
          <Skeleton className="h-[52px] w-[52px] rounded-[14px]" />
          <div className="space-y-2">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-3.5 w-72 max-w-full" />
          </div>
        </div>
      ) : team.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{team.error.code}</CardTitle>
            <CardDescription>{team.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : team.data ? (
        <>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-center gap-4">
              <OwnerAvatar name={team.data.name} size={52} shape="square" className="rounded-[14px] text-lg" />
              <div className="min-w-0">
                <h1 className="truncate font-serif text-[26px] font-medium leading-tight tracking-[-0.01em] sm:text-[28px]">
                  {team.data.name}
                </h1>
                <div className="mt-1 truncate font-mono text-xs text-muted-foreground/85">
                  {team.data.handle ? `@${team.data.handle}` : team.data.slug}
                  {resolveStrings.length > 0
                    ? ` · resolves from git owner strings ${resolveStrings.map((s) => `“${s}”`).join(", ")}`
                    : " · no git owner strings mapped yet"}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
              {team.data.status !== "active" ? <Pill tone="neutral">{team.data.status}</Pill> : null}
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
            </div>
          </div>
          {team.data.description ? (
            <p className="mt-3 max-w-[560px] text-[13px] leading-normal text-muted-foreground">{team.data.description}</p>
          ) : null}
        </>
      ) : null}

      {/* ── Two-column body ── */}
      <div className="mt-8 grid items-start gap-3.5 lg:grid-cols-[1.6fr_1fr]">
        {/* main column */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Owned services */}
          <ListCard>
            <ListCardHeader
              title={<>Owned services · {catalog.loading && !catalog.data ? "…" : ownedCount}</>}
              action={<QuietLink href={`/orgs/${slug}/catalog`}>Catalog →</QuietLink>}
            />
            {catalog.loading && !catalog.data ? (
              <CardSkeleton />
            ) : ownedCount === 0 ? (
              <CardNote>
                No owned services yet — set an entity&rsquo;s git <code className="font-mono text-[11.5px]">owner:</code> to this
                team&rsquo;s handle, or add an owner alias.
              </CardNote>
            ) : (
              ownedServices.map((s) => {
                const sc = scorecardOf(s);
                const tier = tierOf(sc.score, sc.known);
                const h = healthOf(s);
                const tone: Tone = h === "degraded" ? "warning" : h === "down" ? "error" : h === "healthy" ? "success" : "neutral";
                return (
                  <ListRow key={s.key} href={`/orgs/${slug}/catalog/${s.key}`} chevron className="py-3">
                    <StatusDot tone={tone} />
                    <span className="truncate font-mono text-[12.5px] font-medium">{s.name}</span>
                    <span className="hidden shrink-0 text-[11.5px] text-muted-foreground/80 sm:inline">{s.kind.toLowerCase()}</span>
                    <span className="ml-auto flex shrink-0 items-center gap-3">
                      {tier ? (
                        <span className={`text-[11.5px] font-medium ${tier === "Gold" ? "text-[#9A7B2D]" : "text-muted-foreground"}`}>
                          {tier}
                        </span>
                      ) : null}
                      {s.slo != null ? (
                        <span className="w-[52px] text-right text-[11.5px] tabular-nums text-muted-foreground">{s.slo}%</span>
                      ) : null}
                    </span>
                  </ListRow>
                );
              })
            )}
          </ListCard>

          {/* Members */}
          <ListCard>
            <ListCardHeader
              title={<>Members · {members.loading && !members.data ? "…" : memberCount}</>}
              action={
                <Dialog open={addOpen} onOpenChange={setAddOpen}>
                  <DialogTrigger asChild>
                    <button type="button" className="cursor-pointer text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
                      Add member
                    </button>
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
                        <Button onClick={addMember} loading={busy}>Add member</Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              }
            />
            {members.loading && !members.data ? (
              <CardSkeleton />
            ) : members.error ? (
              <CardNote>
                {members.error.code} — {members.error.message}
              </CardNote>
            ) : !members.data || members.data.length === 0 ? (
              <CardNote>No members yet — add people to give them everything this team can do.</CardNote>
            ) : (
              members.data.map((m) => {
                const isAdmin = (m.teamRole ?? "team_member") === "team_admin";
                return (
                  <ListRow key={m.subjectId} className="py-[9px]">
                    <PersonAvatar name={m.subjectId} size={26} className="text-[9.5px]" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12.5px] font-medium">{m.subjectId}</span>
                      <span className="block truncate text-[11px] text-muted-foreground/80">{m.subjectType}</span>
                    </span>
                    {isAdmin ? (
                      <Pill tone="info" className="px-[9px] text-[11px]">admin</Pill>
                    ) : null}
                    {m.status !== "active" ? (
                      <Pill tone="neutral" className="px-[9px] text-[11px]">{m.status}</Pill>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={`Manage ${m.subjectId}`}
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => changeMemberRole(m.subjectId, isAdmin ? "team_member" : "team_admin")}>
                          {isAdmin ? "Make member" : "Make admin"}
                        </DropdownMenuItem>
                        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPendingRemove(m.subjectId)}>
                          Remove from team
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ListRow>
                );
              })
            )}
          </ListCard>

          {/* Recent activity */}
          <ListCard>
            <ListCardHeader title="Recent activity" />
            {activity.loading && !activity.data ? (
              <CardSkeleton rows={4} />
            ) : activity.error || !activity.data || activityRows(activity.data).length === 0 ? (
              <CardNote>No recent activity — runs in workspaces you can read will show up here.</CardNote>
            ) : (
              <>
                {activityRows(activity.data).map((r) => {
                  const tone: Tone =
                    r.status === "succeeded" ? "success" : r.status === "failed" ? "error" : r.status === "running" ? "info" : "neutral";
                  return (
                    <ListRow key={`${r.workspace}-${r.runId}`} className="py-[11px]">
                      <StatusDot tone={tone} live={r.status === "running"} />
                      <span className="min-w-0 flex-1 truncate text-[13px]">
                        <span className="font-medium">{r.workspace}</span>
                        <span className="text-muted-foreground"> · {r.environment ?? "—"}</span>
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground/85">{r.runId}</span>
                    </ListRow>
                  );
                })}
                {activity.data.truncated ? (
                  <CardNote>Largest accounts truncated to the first 20 workspaces.</CardNote>
                ) : null}
              </>
            )}
          </ListCard>
        </div>

        {/* right rail */}
        <div className="flex min-w-0 flex-col gap-3.5">
          {/* Access (grants) */}
          <ListCard>
            <ListCardHeader
              title={<>Access · {grants.loading && !grants.data ? "…" : grantCount}</>}
              action={
                <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
                  <DialogTrigger asChild>
                    <button type="button" className="cursor-pointer text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
                      Grant role
                    </button>
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
                          <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3">
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
                        <Button onClick={grantRole} loading={busy}>Grant role</Button>
                      </div>
                    </div>
                  </DialogContent>
                </Dialog>
              }
            />
            {grants.loading && !grants.data ? (
              <CardSkeleton />
            ) : grants.error ? (
              <CardNote>
                {grants.error.code} — {grants.error.message}
              </CardNote>
            ) : !grants.data || grants.data.length === 0 ? (
              <CardNote>No grants yet — grant the team a role to give every member access in one move.</CardNote>
            ) : (
              grants.data.map((g) => (
                <ListRow key={`${g.orgId}-${g.role}-${g.scopeKind}-${g.scopeRef ?? ""}`} className="py-[9px]">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium">{g.role}</span>
                    <span className="block truncate text-[11px] text-muted-foreground/80">
                      {g.scopeKind === "account"
                        ? "every workspace"
                        : g.scopeKind === "project"
                          ? `project ${g.scopeRef ?? ""} · ${workspaceName(g.orgId)}`
                          : workspaceName(g.orgId)}
                    </span>
                  </span>
                  <Pill tone={g.scopeKind === "account" ? "info" : "neutral"} className="px-2 text-[10.5px]">
                    {g.scopeKind === "account" ? "account" : g.scopeKind}
                  </Pill>
                  <button
                    type="button"
                    onClick={() => setPendingRevoke(g)}
                    className="shrink-0 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:text-destructive"
                  >
                    Revoke
                  </button>
                </ListRow>
              ))
            )}
          </ListCard>

          {/* Owner resolution (aliases) */}
          <Card className="px-5 py-[18px]">
            <Kicker>Owner resolution</Kicker>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Extra git <code className="font-mono text-[11px]">owner:</code> strings that resolve to this team. The handle already
              resolves — add aliases only for legacy or differently-spelled strings.
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                placeholder="e.g. legacy-payments"
                value={aliasInput}
                onChange={(e) => setAliasInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addAlias()}
                className="h-8 text-xs"
              />
              <Button variant="outline" size="sm" onClick={addAlias}>
                Add
              </Button>
            </div>
            {ownerHandles.loading && !ownerHandles.data ? (
              <Skeleton className="mt-3 h-8 w-full" />
            ) : teamAliases.length === 0 ? (
              <p className="mt-3 text-xs text-muted-foreground/80">No aliases — this team is resolved by its handle.</p>
            ) : (
              <div className="mt-3 flex flex-col">
                {teamAliases.map((h) => (
                  <div key={h.ownerHandle} className="flex items-center gap-2 border-t border-border/50 py-2 first:border-t-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-secondary-foreground">{h.ownerHandle}</span>
                    <button
                      type="button"
                      onClick={() => removeAlias(h.ownerHandle)}
                      aria-label={`Remove alias ${h.ownerHandle}`}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Danger zone */}
          <Card className="px-5 py-[18px]">
            <Kicker className="text-destructive/70">Danger zone</Kicker>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Deleting a team revokes its grants and clears its ownership. This cannot be undone.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 text-destructive hover:bg-destructive-soft hover:text-destructive"
              onClick={() => setPendingDelete(true)}
            >
              Delete team
            </Button>
          </Card>
        </div>
      </div>
    </Screen>
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
        <Button variant="outline" size="sm">Edit team</Button>
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
