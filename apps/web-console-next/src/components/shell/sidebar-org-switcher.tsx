"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Check, Plus, Building2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useSession } from "@/lib/session";
import { wrap } from "@/lib/api";
import { useApiQuery, qk } from "@/lib/query";
import { useEffectiveOrgSlug } from "./use-effective-org";
import { workspaceKindBadge, accountNameFor } from "./workspace-kind";

/**
 * Org switcher anchored at the top of the sidebar (Vercel's team-switcher
 * pattern): the current org as an avatar + name, opening a dropdown of orgs to
 * switch between, plus shortcuts to the full list and creating one.
 *
 * The displayed org is the *effective* org (URL → last-used → account default),
 * not the raw URL slug, so the rail always shows a concrete workspace and never
 * an org-less "Select organization" placeholder — even on org-less routes like
 * `/orgs` or `/account`.
 */
export function SidebarOrgSwitcher({ onNavigate }: { onNavigate?: () => void } = {}) {
  const router = useRouter();
  const { client, token } = useSession();
  // Always resolve to a concrete org so the switcher never reads "Select
  // organization"; the dropdown still lets the operator switch explicitly.
  const orgSlug = useEffectiveOrgSlug();
  // Shared `orgs` query (PERF11): reuses the same cache entry as the page list
  // and `useOrgBySlug`, so the shell paints from cache and never fires a
  // duplicate org-list request on mount.
  const orgs =
    useApiQuery(
      qk.orgs(),
      () => wrap(async () => (await client.organizations.list()).organizations),
      { enabled: !!token },
    ).data;
  const go = (href: string) => {
    onNavigate?.();
    router.push(href);
  };

  const current = orgs?.find((o) => o.slug === orgSlug) ?? null;
  const label = current?.name ?? orgSlug ?? "Select workspace";
  const seed = (label.trim()[0] ?? "S").toUpperCase();
  const kind = (current && workspaceKindBadge(current)) || "workspace";

  return (
    <DropdownMenu>
      {/* Northwind switcher: white card, ink logo square, name over kind. */}
      <DropdownMenuTrigger className="flex w-full items-center gap-[9px] rounded-[9px] border border-border bg-card p-2 text-left transition-colors hover:bg-accent/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-foreground text-xs font-bold text-background">
          {seed}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[13px] font-semibold">{label}</span>
          <span className="truncate text-[11px] font-normal lowercase text-muted-foreground">{kind}</span>
        </span>
        <ChevronsUpDown className="h-[13px] w-[13px] shrink-0 text-muted-foreground/70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {orgs?.map((o) => {
          // Account vs Workspace badge (WID4/WID5); omitted on older payloads.
          const badge = workspaceKindBadge(o);
          // A child workspace shows which Account it belongs to (IT9).
          const accountName = orgs ? accountNameFor(o, orgs) : null;
          const selected = o.slug === orgSlug;
          return (
            <DropdownMenuItem key={o.id} onSelect={() => go(`/orgs/${o.slug}`)}>
              <Building2 className="h-4 w-4 opacity-70" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{o.name}</span>
                {accountName && (
                  <span className="truncate text-[10px] text-muted-foreground">
                    in {accountName}
                  </span>
                )}
              </span>
              {badge && (
                <span className="ml-2 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {badge}
                </span>
              )}
              {selected && <Check className="ml-auto h-4 w-4" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => go("/orgs")}>
          View all workspaces…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => go("/orgs")}>
          <Plus className="h-4 w-4 opacity-70" /> Create workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
