"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  buildSettingsNav,
  flattenSettingsNav,
  isSettingsLinkActive,
} from "@/components/shell/settings-nav";
import { useEntranceFade } from "@/components/ui/northwind";
import { buildAccountNav, isAccountSettingsPath } from "@/components/shell/account-nav";

/**
 * Northwind Settings frame: the main product rail stays put (Settings lit),
 * and the surface itself is a two-column layout — a sticky secondary nav on
 * the left (serif heading over grouped 13px links) and the stacked settings
 * panels on the right. On mobile the secondary nav collapses into a
 * horizontally-swipable chip row above the content.
 *
 * The rail is scope-aware (saas-settings-ia SI2): under the Account doorway
 * (`/settings/account/*` and the account-billed `/settings/billing`) it renders
 * the Account nav (`buildAccountNav`) with a "Workspace settings" back-link;
 * everywhere else it renders the Workspace settings nav plus an "Account
 * settings" doorway link. Account and Workspace are the two tenancy scopes; the
 * personal ("You") scope lives in the identity chip, not here.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  // IC4: entrance fade is once-per-document, shared with Screen.
  const fade = useEntranceFade();
  const params = useParams<{ orgSlug?: string }>();
  const pathname = usePathname();
  const orgSlug = params?.orgSlug ?? "";
  const base = `/orgs/${orgSlug}/settings`;

  const onAccount = isAccountSettingsPath(pathname);
  const groups = onAccount ? buildAccountNav(orgSlug) : buildSettingsNav(orgSlug);
  const flat = flattenSettingsNav(groups);
  const heading = onAccount ? "Account" : "Settings";

  // The doorway cross-link: from the Workspace rail, jump up to Account
  // settings; from the Account rail, back to Workspace settings.
  const doorway = onAccount
    ? { href: base, label: "Workspace settings", icon: ArrowLeft }
    : { href: `${base}/account`, label: "Account settings", icon: ArrowUpRight };
  const DoorwayIcon = doorway.icon;

  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 pb-20 pt-8 sm:px-8 lg:flex lg:items-start lg:gap-11 lg:px-12 lg:pt-[52px]">
      {/* Desktop secondary nav */}
      <nav className="sticky top-[52px] hidden w-[210px] shrink-0 lg:block" aria-label={`${heading} settings`}>
        <h1 className="mb-[22px] font-serif text-[28px] font-medium tracking-[-0.01em]">{heading}</h1>
        {groups.map((group) => (
          <div key={group.id} className="mb-1">
            <div className="px-2 pb-[7px] pt-4 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/85 first:pt-0">
              {group.label}
            </div>
            <div className="flex flex-col gap-px">
              {group.links.map((link) => {
                const active = isSettingsLinkActive(link, pathname);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "rounded-[7px] px-2 py-1.5 text-[13px] transition-colors duration-100",
                      active
                        ? "bg-accent font-semibold text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}

        {/* Doorway cross-link between the Account and Workspace scopes. */}
        <div className="mt-4 border-t pt-3">
          <Link
            href={doorway.href}
            className="flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <DoorwayIcon className="h-3.5 w-3.5" />
            {doorway.label}
          </Link>
        </div>
      </nav>

      {/* Mobile header + swipable section chips */}
      <div className="lg:hidden">
        <h1 className="font-serif text-[26px] font-medium tracking-[-0.01em]">{heading}</h1>
        <div className="-mx-5 mt-4 flex gap-[7px] overflow-x-auto px-5 pb-1 scrollbar-none sm:-mx-8 sm:px-8">
          <Link
            href={doorway.href}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-border bg-card px-[13px] py-[5px] text-[12.5px] text-muted-foreground transition-colors"
          >
            <DoorwayIcon className="h-3 w-3" />
            {doorway.label}
          </Link>
          {flat.map((link) => {
            const active = isSettingsLinkActive(link, pathname);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-full border px-[13px] py-[5px] text-[12.5px] transition-colors",
                  active
                    ? "border-primary bg-primary font-medium text-primary-foreground"
                    : "border-border bg-card text-muted-foreground",
                )}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </div>

      <div className={cn("mt-6 min-w-0 flex-1 lg:mt-0 lg:pt-1.5", fade && "animate-fade-up")}>{children}</div>
    </div>
  );
}
