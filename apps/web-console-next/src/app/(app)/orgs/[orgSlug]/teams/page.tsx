"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, Search, Users, Boxes, UsersRound } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { wrap } from "@/lib/api";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import { TeamAvatar } from "@/components/teams/team-avatar";
import type { PublicTeam } from "@saas/contracts/membership";

const schema = z.object({
  name: z.string().min(1, "Enter a team name"),
  handle: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}$/, "2–39 chars: lower-case letters, digits, hyphens; no leading hyphen")
    .optional()
    .or(z.literal("")),
  description: z.string().max(500, "At most 500 characters").optional(),
});

export default function TeamsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} slug={slug} />}</OrgScope>;
}

function Inner({ orgId, slug }: { orgId: string; slug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [mine, setMine] = React.useState(false);

  const teams = useApiQuery(qk.teams(orgId), () =>
    wrap(async () => (await client.teams.listTeams(orgId)).teams),
  );
  const myTeams = useApiQuery(["myTeams", orgId] as const, () =>
    wrap(async () => (await client.teams.myTeams(orgId)).teams),
  );
  const myTeamIds = React.useMemo(() => new Set((myTeams.data ?? []).map((t) => t.id)), [myTeams.data]);

  // Owned-service counts per team, resolved from the catalog once (no N+1).
  const catalog = useApiQuery(qk.orgCatalog(orgId), () =>
    wrap(() => collectOrgCatalog((q) => client.state.listOrgCatalogEntities(orgId, q))),
  );
  const ownerStrings = React.useMemo(
    () => [...new Set((catalog.data ?? []).map((e) => e.owner).filter((o): o is string => !!o))],
    [catalog.data],
  );
  const ownerResolutions = useApiQuery(["ownerResolutions", orgId, ownerStrings.join("\n")] as const, () =>
    wrap(async () => (await client.teams.resolveOwners(orgId, { owners: ownerStrings })).resolutions),
  );
  const ownedByTeam = React.useMemo(() => {
    const byOwner = new Map((ownerResolutions.data ?? []).map((r) => [r.owner, r]));
    const counts = new Map<string, number>();
    for (const e of catalog.data ?? []) {
      if (!e.owner) continue;
      const r = byOwner.get(e.owner);
      if (r && r.state === "owned" && r.teamId) counts.set(r.teamId, (counts.get(r.teamId) ?? 0) + 1);
    }
    return counts;
  }, [catalog.data, ownerResolutions.data]);

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return (teams.data ?? []).filter((t) => {
      if (mine && !myTeamIds.has(t.id)) return false;
      if (q) {
        const hay = `${t.name} ${t.handle ?? ""} ${t.slug} ${t.description ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [teams.data, query, mine, myTeamIds]);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Teams</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Named groups of people you grant roles to and assign ownership. A role or a service given to a team
            reaches every member — grant it at account scope to cover every workspace.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1.5 size-4" /> New team
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create team</DialogTitle>
              <DialogDescription>Teams are owned by the account and can be granted roles on any workspace.</DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={schema}
              defaultValues={{ name: "", handle: "", description: "" }}
              fields={[
                { name: "name", label: "Name", placeholder: "Platform Engineering" },
                { name: "handle", label: "Handle", hint: "Optional — mentionable @handle, e.g. platform", placeholder: "platform" },
                { name: "description", label: "Description", hint: "Optional" },
              ]}
              submitLabel="Create team"
              cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  client.teams.createTeam(orgId, {
                    name: v.name,
                    ...(v.handle ? { handle: v.handle } : {}),
                    ...(v.description ? { description: v.description } : {}),
                  }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                toast({ kind: "success", title: "Team created" });
                setOpen(false);
                teams.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-muted-foreground/80" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teams…"
            aria-label="Search teams"
            className="h-[34px] w-[240px] rounded-lg border border-border bg-card pl-[30px] pr-[11px] text-[13px] text-foreground outline-none placeholder:text-muted-foreground/60"
          />
        </div>
        <button
          type="button"
          onClick={() => setMine((v) => !v)}
          aria-pressed={mine}
          className={`h-[34px] rounded-lg border px-3 text-[13px] outline-none ${mine ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground"}`}
        >
          My teams
        </button>
        {teams.data ? (
          <span className="ml-auto text-[12px] text-muted-foreground">
            {visible.length} {visible.length === 1 ? "team" : "teams"}
          </span>
        ) : null}
      </div>

      {teams.loading ? (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : teams.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{teams.error.code}</CardTitle>
            <CardDescription>{teams.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : (teams.data ?? []).length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title="No teams yet"
          description="Create a team to grant a role to a group of people at once and give them ownership of services."
          primaryAction={{ label: "New team", onClick: () => setOpen(true) }}
        />
      ) : visible.length === 0 ? (
        <EmptyState icon={Search} title="No matching teams" description="Try a different search or clear the My-teams filter." />
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Team</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead className="text-right">Owned services</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((t: PublicTeam) => {
                const owned = ownedByTeam.get(t.id) ?? 0;
                const href = `/orgs/${slug}/teams/${t.id}`;
                return (
                  <TableRow key={t.id} className="group">
                    <TableCell>
                      <Link href={href} className="flex items-center gap-3">
                        <TeamAvatar name={t.name} seed={t.handle ?? null} />
                        <span className="min-w-0">
                          <span className="flex items-center gap-2">
                            <span className="truncate font-medium text-foreground group-hover:underline">{t.name}</span>
                            {t.handle ? <span className="truncate font-mono text-[11px] text-muted-foreground">@{t.handle}</span> : null}
                            {myTeamIds.has(t.id) ? <Badge variant="secondary" className="h-[18px] px-1.5 text-[10px]">You</Badge> : null}
                          </span>
                          {t.description ? (
                            <span className="mt-0.5 block max-w-md truncate text-[12px] text-muted-foreground">{t.description}</span>
                          ) : null}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Users className="size-3.5 opacity-70" />
                        {t.memberCount ?? 0}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <Boxes className="size-3.5 opacity-70" />
                        {owned}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.status === "active" ? "default" : "secondary"}>{t.status}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
