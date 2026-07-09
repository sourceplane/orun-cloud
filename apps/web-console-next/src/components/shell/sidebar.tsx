"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import {
  BookOpen,
  Bot,
  Building2,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Boxes,
  KeyRound,
  Settings,
  SlidersHorizontal,
  ScrollText,
  Receipt,
  Users,
  Mail,
  Webhook,
  ShieldCheck,
  Bell,
  Gauge,
  User2,
  Plug,
  GitBranch,
  Terminal,
  Play,
  HardDrive,
  Activity,
  UsersRound,
  Radio,
  BellRing,
  Slack,
  Inbox,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { buildNavSections, isLinkActive } from "./nav-items";
import { SidebarAccount } from "./sidebar-account";
import { SidebarOrgSwitcher } from "./sidebar-org-switcher";
import { SidebarFind } from "./sidebar-find";
import { useEffectiveOrgSlug } from "./use-effective-org";

const ICONS: Record<string, LucideIcon> = {
  Bot,
  Building2,
  FolderKanban,
  Boxes,
  BookOpen,
  KeyRound,
  Settings,
  SlidersHorizontal,
  ScrollText,
  Receipt,
  Users,
  Mail,
  Webhook,
  ShieldCheck,
  Bell,
  Gauge,
  User2,
  Plug,
  GitBranch,
  Terminal,
  Play,
  HardDrive,
  Activity,
  UsersRound,
  Radio,
  BellRing,
  Slack,
  Inbox,
};

/**
 * Shared nav body (sections + links), rendered by both the desktop sidebar and
 * the mobile Sheet drawer. `onNavigate` lets the drawer close itself on click.
 *
 * `mobile` switches to a touch layout: sections are flat (no collapse toggles),
 * rows are ≥44px with press feedback, and type is a touch larger.
 */
export function NavContent({
  onNavigate,
  mobile = false,
}: {
  onNavigate?: (() => void) | undefined;
  mobile?: boolean;
}) {
  const params = useParams<{ projectSlug?: string }>();
  const pathname = usePathname();
  // Drive the nav from the active workspace (URL → last-used → default), not the
  // raw URL slug, so the product nav stays in lockstep with the org switcher
  // even on org-less routes (`/orgs`, `/account`) — the chrome always reflects a
  // genuinely-selected org instead of collapsing to an empty rail.
  const orgSlug = useEffectiveOrgSlug();

  // Northwind keeps one stable product rail everywhere. Inside `/settings`
  // the Settings row simply stays lit and the settings surface renders its own
  // in-page secondary nav (see the settings layout) — the rail never swaps.
  return (
    <div className="flex min-h-full flex-col">
      <ProductNav
        orgSlug={orgSlug}
        projectSlug={params?.projectSlug ?? null}
        pathname={pathname}
        onNavigate={onNavigate}
        mobile={mobile}
      />
    </div>
  );
}

function ProductNav({
  orgSlug,
  projectSlug,
  pathname,
  onNavigate,
  mobile,
}: {
  orgSlug: string | null;
  projectSlug: string | null;
  pathname: string | null;
  onNavigate?: (() => void) | undefined;
  mobile: boolean;
}) {
  const sections = buildNavSections({ orgSlug, projectSlug });
  const primary = sections.filter((s) => !s.footer);
  const footer = sections.filter((s) => s.footer);

  const renderLink = (link: (typeof sections)[number]["links"][number]) => {
    const Icon = ICONS[link.icon] ?? Settings;
    return (
      <SidebarLink
        key={link.href}
        href={link.href}
        icon={Icon}
        active={isLinkActive(link.href, pathname)}
        onClick={onNavigate}
        mobile={mobile}
        chevron={!!link.subPanel}
      >
        {link.label}
      </SidebarLink>
    );
  };

  return (
    <nav className="flex flex-1 flex-col px-2 pb-4 pt-3">
      <div className={mobile ? "space-y-5" : "space-y-6"}>
        {primary.map((section) => (
          <Section key={section.id} label={section.label} mobile={mobile}>
            {section.links.map(renderLink)}
          </Section>
        ))}
      </div>

      {/* "Manage" surfaces pinned to the bottom (mt-auto), above the account
          chip. A divider separates them from the product nav above. */}
      {footer.length > 0 ? (
        <div className="mt-auto space-y-0.5 border-t pt-3">
          {footer.flatMap((s) => s.links).map(renderLink)}
        </div>
      ) : null}
    </nav>
  );
}

export function Sidebar() {
  return (
    // Sticky, full-viewport-height rail that stays put while the page scrolls.
    // `self-start` keeps it from stretching to the (taller) content so `sticky`
    // can pin it; the nav scrolls in its own region and the account chip is
    // pinned at the bottom.
    // Northwind rail: 230px, #F5F5F5, hairline right border.
    <aside className="sticky top-0 hidden h-dvh w-[230px] shrink-0 flex-col self-start border-r bg-secondary md:flex">
      <div className="shrink-0 space-y-2.5 px-2.5 pb-2.5 pt-3">
        <SidebarOrgSwitcher />
        <SidebarFind />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <NavContent />
      </div>

      <div className="shrink-0 border-t p-2.5">
        <SidebarAccount />
      </div>
    </aside>
  );
}

function Section({
  label,
  children,
  mobile = false,
}: {
  label: string;
  children: React.ReactNode;
  mobile?: boolean;
}) {
  const [open, setOpen] = React.useState(true);

  // On mobile the collapse affordance is friction, not value — render a static
  // section label and always show the links.
  if (mobile) {
    return (
      <div>
        <div className="px-3 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/85">
          {label}
        </div>
        <div className="space-y-px">{children}</div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted-foreground/85 hover:text-foreground"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="space-y-px">{children}</div>}
    </div>
  );
}

function SidebarLink({
  href,
  icon: Icon,
  active,
  onClick,
  mobile = false,
  chevron = false,
  children,
}: {
  href: string;
  icon: LucideIcon;
  active: boolean;
  onClick?: (() => void) | undefined;
  mobile?: boolean;
  /** Show a trailing › to signal the link opens a nested sidebar panel. */
  chevron?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      {...(onClick ? { onClick } : {})}
      className={cn(
        "flex items-center rounded-[7px] transition-colors duration-100",
        mobile ? "min-h-11 gap-3 px-3 text-[15px] active:bg-accent" : "gap-[9px] px-2 py-1.5 text-[13px]",
        active
          ? "bg-foreground/[0.09] font-semibold text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon strokeWidth={1.8} className={cn(mobile ? "h-5 w-5" : "h-[15px] w-[15px]")} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {chevron && <ChevronRight className={cn("shrink-0 opacity-50", mobile ? "h-4 w-4" : "h-3 w-3")} />}
    </Link>
  );
}
