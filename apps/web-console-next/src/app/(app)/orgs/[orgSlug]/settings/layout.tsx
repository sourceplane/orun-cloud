"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import {
  buildSettingsNav,
  flattenSettingsNav,
  isSettingsLinkActive,
} from "@/components/shell/settings-nav";

/**
 * Northwind Settings frame: the main product rail stays put (Settings lit),
 * and the surface itself is a two-column layout — a sticky secondary nav on
 * the left (serif "Settings" heading over grouped 13px links) and the stacked
 * settings panels on the right. On mobile the secondary nav collapses into a
 * horizontally-swipable chip row above the content.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ orgSlug?: string }>();
  const pathname = usePathname();
  const orgSlug = params?.orgSlug ?? "";
  const groups = buildSettingsNav(orgSlug);
  const flat = flattenSettingsNav(groups);

  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 pb-20 pt-8 sm:px-8 lg:flex lg:items-start lg:gap-11 lg:px-12 lg:pt-[52px]">
      {/* Desktop secondary nav */}
      <nav className="sticky top-[52px] hidden w-[210px] shrink-0 lg:block" aria-label="Settings">
        <h1 className="mb-[22px] font-serif text-[28px] font-medium tracking-[-0.01em]">Settings</h1>
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
      </nav>

      {/* Mobile header + swipable section chips */}
      <div className="lg:hidden">
        <h1 className="font-serif text-[26px] font-medium tracking-[-0.01em]">Settings</h1>
        <div className="-mx-5 mt-4 flex gap-[7px] overflow-x-auto px-5 pb-1 scrollbar-none sm:-mx-8 sm:px-8">
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

      <div className="mt-6 min-w-0 flex-1 animate-fade-up lg:mt-0 lg:pt-1.5">{children}</div>
    </div>
  );
}
