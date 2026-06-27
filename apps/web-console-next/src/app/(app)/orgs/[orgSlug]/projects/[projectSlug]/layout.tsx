"use client";

// Repo settings frame. Selecting a repo from "Git Repos" lands here: a
// settings-style page whose sections live in a horizontal tab bar (Environments
// · Git · CLI · Storage · Config), mirroring how a project's settings read in
// Vercel/Linear. The per-repo sidebar section is gone — selection happens here.
//
// Full-screen drill-ins under the repo (the run detail, reached from the org
// Activities feed) render without the tab chrome.

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ChevronLeft, Boxes, GitBranch, Terminal, HardDrive, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { buildRepoTabs, isRepoTabActive, isRepoDetailRoute } from "@/components/shell/repo-tabs";

const ICONS: Record<string, LucideIcon> = {
  Boxes,
  GitBranch,
  Terminal,
  HardDrive,
  SlidersHorizontal,
};

export default function RepoLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ orgSlug: string; projectSlug: string }>();
  const pathname = usePathname();
  const orgSlug = params?.orgSlug ?? "";
  const projectSlug = params?.projectSlug ?? "";

  // The run detail (and the bare `/runs` redirect) are full-screen drill-ins —
  // no repo tab chrome.
  if (isRepoDetailRoute(pathname)) return <>{children}</>;

  const tabs = buildRepoTabs(orgSlug, projectSlug);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <Link
          href={`/orgs/${orgSlug}/projects`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Git Repos
        </Link>
        <h1 className="font-mono text-lg font-semibold tracking-tight">{projectSlug}</h1>

        {/* Horizontal tab bar (route-based). Scrolls on narrow screens. */}
        <nav className="-mb-px flex gap-1 overflow-x-auto border-b scrollbar-thin" aria-label="Repo settings">
          {tabs.map((tab) => {
            const Icon = ICONS[tab.icon];
            const active = isRepoTabActive(tab.href, pathname);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors",
                  active
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {Icon ? <Icon className="h-4 w-4 opacity-80" /> : null}
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </div>

      {children}
    </div>
  );
}
