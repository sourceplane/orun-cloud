"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Search, UsersRound } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, InteractiveCard } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import {
  AttentionBanner,
  Chip,
  OwnerAvatar,
  PageHeader,
  Pill,
  Screen,
} from "@/components/ui/northwind";
import { wrap } from "@/lib/api";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import {
  annotateOwnership,
  healthOf,
  isResource,
  scorecardOf,
  tierOf,
  toServices,
  type CatalogService,
} from "@/lib/catalog-portal/model";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
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

  // Owned services per team, resolved from the catalog once (no N+1).
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
  const services = React.useMemo(() => toServices(catalog.data ?? []), [catalog.data]);
  const resolvedServices = React.useMemo(() => {
    const byOwner = new Map((ownerResolutions.data ?? []).map((r) => [r.owner, r]));
    return annotateOwnership(services, byOwner);
  }, [services, ownerResolutions.data]);
  const ownedByTeam = React.useMemo(() => {
    const m = new Map<string, CatalogService[]>();
    for (const s of resolvedServices) {
      if (s.ownerState === "owned" && s.ownerTeam) {
        const list = m.get(s.ownerTeam.teamId) ?? [];
        list.push(s);
        m.set(s.ownerTeam.teamId, list);
      }
    }
    return m;
  }, [resolvedServices]);
  // Entities that declare no owner at all (resources excluded — they're managed).
  const unowned = React.useMemo(
    () => resolvedServices.filter((s) => !isResource(s) && !s.owner),
    [resolvedServices],
  );

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
    <Screen>
      <PageHeader
        title="Teams"
        description="The humans behind the services. Ownership resolves from git owner strings to these teams."
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>New team</Button>
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
        }
      />

      {/* toolbar */}
      <div className="mt-7 flex flex-wrap items-center gap-2.5">
        <div className="relative flex items-center">
          <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-muted-foreground/70" strokeWidth={1.8} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search teams…"
            aria-label="Search teams"
            className="h-[33px] w-[220px] rounded-full border border-border bg-card pl-[32px] pr-3.5 text-[12.5px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-foreground/25"
          />
        </div>
        <Chip active={mine} onClick={() => setMine((v) => !v)} aria-pressed={mine}>
          My teams
        </Chip>
        {teams.data ? (
          <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
            {visible.length} of {(teams.data ?? []).length} shown
          </span>
        ) : null}
      </div>

      {teams.loading ? (
        <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[150px] w-full rounded-xl" />
          ))}
        </div>
      ) : teams.error ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-destructive">{teams.error.code}</CardTitle>
            <CardDescription>{teams.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : (teams.data ?? []).length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={UsersRound}
            title="No teams yet"
            description="Create a team to grant a role to a group of people at once and give them ownership of services."
            primaryAction={{ label: "New team", onClick: () => setOpen(true) }}
          />
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-4">
          <EmptyState icon={Search} title="No matching teams" description="Try a different search or clear the My-teams filter." />
        </div>
      ) : (
        <div className="mt-4 grid gap-3.5 sm:grid-cols-2">
          {visible.map((t: PublicTeam) => (
            <TeamCard
              key={t.id}
              team={t}
              href={`/orgs/${slug}/teams/${t.id}`}
              owned={ownedByTeam.get(t.id) ?? []}
              you={myTeamIds.has(t.id)}
            />
          ))}
        </div>
      )}

      {unowned.length > 0 ? (
        <AttentionBanner className="mt-[22px]">
          <span className="font-mono text-xs">{unowned[0]?.name}</span>
          {unowned.length > 1 ? ` and ${unowned.length - 1} more declare no owner.` : " declares no owner."}{" "}
          Map {unowned.length > 1 ? "them" : "it"} to a team so pages and on-call resolve.
        </AttentionBanner>
      ) : null}
    </Screen>
  );
}

const CHIP_LIMIT = 3;

function TeamCard({
  team,
  href,
  owned,
  you,
}: {
  team: PublicTeam;
  href: string;
  owned: CatalogService[];
  you: boolean;
}) {
  const memberCount = team.memberCount ?? 0;
  const svcCount = owned.length;
  const degraded = owned.filter((s) => {
    const h = healthOf(s);
    return h === "degraded" || h === "down";
  }).length;
  const gold = owned.filter((s) => {
    const sc = scorecardOf(s);
    return tierOf(sc.score, sc.known) === "Gold";
  }).length;
  const onCall = owned.find((s) => s.onCall)?.onCall ?? null;
  const chips = owned.slice(0, CHIP_LIMIT);
  const overflow = svcCount - chips.length;

  return (
    <Link href={href} className="min-w-0">
      <InteractiveCard className="h-full px-[22px] py-5">
        {/* header row */}
        <div className="flex items-center gap-3">
          <OwnerAvatar name={team.name} size={36} shape="square" className="rounded-[10px] text-[13px]" />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-[14.5px] font-semibold leading-tight">{team.name}</span>
              {you ? (
                <Pill tone="neutral" className="px-2 py-0 text-[10px]">
                  you
                </Pill>
              ) : null}
              {team.status !== "active" ? (
                <Pill tone="neutral" className="px-2 py-0 text-[10px]">
                  {team.status}
                </Pill>
              ) : null}
            </span>
            <span className="block truncate font-mono text-[11.5px] text-muted-foreground/75">
              {team.handle ? `@${team.handle}` : team.slug}
            </span>
          </span>
          <span className="ml-auto shrink-0">
            {onCall ? (
              <Pill tone="success" className="text-[12px]">on-call · {onCall}</Pill>
            ) : (
              <Pill tone="neutral" className="text-[12px]">no rotation</Pill>
            )}
          </span>
        </div>

        {/* stats row */}
        <div className="mt-4 flex gap-[22px] text-[12.5px] text-muted-foreground">
          <span>
            <span className="font-semibold text-foreground">{memberCount}</span>{" "}
            {memberCount === 1 ? "member" : "members"}
          </span>
          <span>
            <span className="font-semibold text-foreground">{svcCount}</span>{" "}
            {svcCount === 1 ? "service" : "services"}
          </span>
          {degraded > 0 ? (
            <span>
              <span className="font-semibold text-warning">{degraded}</span> degraded
            </span>
          ) : gold > 0 ? (
            <span>
              <span className="font-semibold text-foreground">{gold}</span> Gold
            </span>
          ) : null}
        </div>

        {/* owned-service chips */}
        {chips.length > 0 ? (
          <div className="mt-3.5 flex flex-wrap gap-1.5">
            {chips.map((s) => (
              <span
                key={s.key}
                className="rounded-md border border-border/70 bg-background px-2 py-[2px] font-mono text-[11px] text-secondary-foreground"
              >
                {s.name}
              </span>
            ))}
            {overflow > 0 ? (
              <span className="px-1 py-[2px] text-[11px] text-muted-foreground/75">+{overflow}</span>
            ) : null}
          </div>
        ) : (
          <div className="mt-3.5 text-[11.5px] text-muted-foreground/70">no owned services yet</div>
        )}
      </InteractiveCard>
    </Link>
  );
}
