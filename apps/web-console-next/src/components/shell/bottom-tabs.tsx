"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Gauge, Settings, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { isLinkActive } from "./nav-items";
import { useEffectiveOrgSlug } from "./use-effective-org";

interface Tab {
  href: string;
  label: string;
  icon: LucideIcon;
}

/**
 * Mobile bottom tab bar (`md:hidden`) for the primary destinations *inside the
 * active organization* — the single biggest "native-app feel" upgrade.
 * Thumb-reachable, fixed to the bottom edge with home-indicator safe-area
 * padding.
 *
 * The organization is ambient context, not a destination: you're always *in* an
 * org (resolved via `useEffectiveOrgSlug` → URL → last-used → default) and you
 * switch it from the topbar workspace switcher, so there is deliberately no
 * "Organizations" tab. The tabs are the day-to-day surfaces — Projects (home),
 * Usage, Settings — and the hamburger drawer still owns the full/contextual nav.
 *
 * Renders nothing only in the transient state where no org is resolvable yet
 * (a zero-org account, which the shell's OnboardingGate redirects to
 * `/onboarding`); there are no org-scoped destinations to show until then.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const orgSlug = useEffectiveOrgSlug();

  if (!orgSlug) return null;

  const tabs: Tab[] = [
    { href: `/orgs/${orgSlug}/projects`, label: "Repos", icon: FolderKanban },
    { href: `/orgs/${orgSlug}/usage`, label: "Usage", icon: Gauge },
    { href: `/orgs/${orgSlug}/settings`, label: "Settings", icon: Settings },
  ];

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/90 backdrop-blur-md pb-safe md:hidden"
    >
      <div className="flex items-stretch">
        {tabs.map((tab) => {
          const active = isLinkActive(tab.href, pathname);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors active:bg-accent/60",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className={cn("h-5 w-5", active && "stroke-[2.25]")} />
              <span className="truncate">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
