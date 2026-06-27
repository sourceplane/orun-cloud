"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import {
  Building2,
  ChevronDown,
  ChevronLeft,
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
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { buildNavSections, isLinkActive } from "./nav-items";
import { buildSettingsNav, flattenSettingsNav, isSettingsLinkActive } from "./settings-nav";
import { SidebarAccount } from "./sidebar-account";
import { SidebarOrgSwitcher } from "./sidebar-org-switcher";
import { SidebarFind } from "./sidebar-find";
import { useEffectiveOrgSlug } from "./use-effective-org";

const ICONS: Record<string, LucideIcon> = {
  Building2,
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

  // The left rail swaps to a dedicated sub-panel for the settings scope only
  // (`/settings`), mirroring how Vercel turns the whole rail into a settings
  // menu. The catalog keeps the stable product nav — its own list is the
  // navigation now, so the rail no longer swaps per selected entity (calmer,
  // and the entity page is a 3-panel surface that keeps the list in view).
  const inSettings = !!orgSlug && !!pathname && pathname.startsWith(`/orgs/${orgSlug}/settings`);
  const mode: "settings" | "product" = inSettings ? "settings" : "product";

  // Subtle directional swap: a sub-panel slides in from the right, back-to-app
  // from the left. The `key` remounts the panel so the animation replays.
  const prev = React.useRef(mode);
  let anim = "";
  if (!mobile && mode !== prev.current) {
    anim = mode === "product" ? "animate-sidebar-in-left" : "animate-sidebar-in-right";
  }
  React.useEffect(() => {
    prev.current = mode;
  }, [mode]);

  return (
    <div key={mode} className={anim}>
      {inSettings && orgSlug && pathname ? (
        <SettingsNavContent orgSlug={orgSlug} pathname={pathname} onNavigate={onNavigate} mobile={mobile} />
      ) : (
        <ProductNav
          orgSlug={orgSlug}
          projectSlug={params?.projectSlug ?? null}
          pathname={pathname}
          onNavigate={onNavigate}
          mobile={mobile}
        />
      )}
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
  return (
    <nav className={cn("px-2 pb-4 pt-3", mobile ? "space-y-5" : "space-y-6")}>
      {sections.map((section) => (
        <Section key={section.id} label={section.label} mobile={mobile}>
          {section.links.map((link) => {
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
          })}
        </Section>
      ))}
    </nav>
  );
}

/**
 * Settings-scoped sidebar: a "‹ Settings" back row that returns to the product
 * area, followed by the flat settings link list with the active item highlighted.
 */
function SettingsNavContent({
  orgSlug,
  pathname,
  onNavigate,
  mobile = false,
}: {
  orgSlug: string;
  pathname: string;
  onNavigate?: (() => void) | undefined;
  mobile?: boolean;
}) {
  const links = flattenSettingsNav(buildSettingsNav(orgSlug));
  return (
    <nav className="px-2 pb-4 pt-3">
      {/* Back button on the left, "Settings" centered (Vercel pattern). */}
      <div className={cn("relative mb-2 flex items-center justify-center", mobile ? "h-11" : "h-8")}>
        <Link
          href={`/orgs/${orgSlug}/projects`}
          {...(onNavigate ? { onClick: onNavigate } : {})}
          aria-label="Back to app"
          className={cn(
            "absolute left-0 grid place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent",
            mobile ? "h-9 w-9" : "h-7 w-7",
          )}
        >
          <ChevronLeft className={mobile ? "h-5 w-5" : "h-4 w-4"} />
        </Link>
        <span className={cn("font-medium tracking-tight", mobile ? "text-base" : "text-sm")}>
          Settings
        </span>
      </div>
      <div className="space-y-0.5">
        {links.map((link) => {
          const active = isSettingsLinkActive(link, pathname);
          return (
            <Link
              key={link.href}
              href={link.href}
              {...(onNavigate ? { onClick: onNavigate } : {})}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center rounded-md transition-colors",
                mobile ? "min-h-11 px-3 text-[15px] active:bg-accent" : "px-2 py-1.5 text-sm",
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

export function Sidebar() {
  return (
    // Sticky, full-viewport-height rail that stays put while the page scrolls.
    // `self-start` keeps it from stretching to the (taller) content so `sticky`
    // can pin it; the nav scrolls in its own region and the account chip is
    // pinned at the bottom.
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col self-start border-r bg-card/40 md:flex">
      <div className="shrink-0 space-y-2 border-b p-2">
        <SidebarOrgSwitcher />
        <SidebarFind />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <NavContent />
      </div>

      <div className="shrink-0 border-t p-2">
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
        <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="mt-1 space-y-0.5">{children}</div>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
      >
        <span className="truncate">{label}</span>
        <ChevronDown className={cn("h-3 w-3 transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="mt-1 space-y-0.5">{children}</div>}
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
        "flex items-center rounded-md transition-colors",
        mobile ? "min-h-11 gap-3 px-3 text-[15px] active:bg-accent" : "gap-2 px-2 py-1.5 text-sm",
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Icon className={cn(active ? "opacity-100" : "opacity-80", mobile ? "h-5 w-5" : "h-4 w-4")} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {chevron && <ChevronRight className={cn("shrink-0 opacity-50", mobile ? "h-4 w-4" : "h-3.5 w-3.5")} />}
    </Link>
  );
}
