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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-gradient-to-br from-primary to-primary/40 text-xs font-bold text-primary-foreground">
          {seed}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tracking-tight">{label}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[240px]">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {orgs?.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => go(`/orgs/${o.slug}/projects`)}>
            <Building2 className="h-4 w-4 opacity-70" />
            <span className="truncate">{o.name}</span>
            {o.slug === orgSlug && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenuItem>
        ))}
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
