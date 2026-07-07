"use client";

/**
 * Northwind design-system building blocks.
 *
 * These encode the recurring recipes of the Northwind console design —
 * serif page headers, kicker labels, stat cards, filter chips, status dots,
 * divided list cards, quiet links, warn banners — so every screen composes
 * the same vocabulary. See docs/northwind-design.md for the full spec.
 */

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/* ── Layout ─────────────────────────────────────────────────────────── */

/** Standard screen container: 1060px column, generous vertical rhythm. */
export function Screen({
  className,
  detail = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { detail?: boolean }) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-[1060px] animate-fade-up px-5 pb-20 sm:px-8 lg:px-12",
        detail ? "pt-7 sm:pt-10" : "pt-8 sm:pt-11 lg:pt-[52px]",
        className,
      )}
      {...props}
    />
  );
}

/** Serif page header with optional description and right-aligned actions. */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-5", className)}>
      <div className="min-w-0">
        <h1 className="font-serif text-[26px] font-medium leading-tight tracking-[-0.01em] sm:text-[28px]">
          {title}
        </h1>
        {description ? (
          <p className="mt-2 max-w-[560px] text-[13.5px] leading-normal text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}

/** Breadcrumb trail for drill-down pages: "Catalog / checkout-api". */
export function Breadcrumbs({
  items,
  className,
}: {
  items: Array<{ label: React.ReactNode; href?: string; mono?: boolean }>;
  className?: string;
}) {
  return (
    <div className={cn("mb-6 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground", className)}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={i}>
            {i > 0 ? <span className="text-foreground/25">/</span> : null}
            {item.href && !last ? (
              <Link href={item.href} className="cursor-pointer transition-colors hover:text-foreground">
                {item.label}
              </Link>
            ) : (
              <span
                className={cn(
                  last && "font-medium text-secondary-foreground",
                  item.mono && "font-mono text-xs",
                )}
              >
                {item.label}
              </span>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ── Labels & links ─────────────────────────────────────────────────── */

/** 11px uppercase section label. */
export function Kicker({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("kicker", className)} {...props} />;
}

/** Quiet trailing link: "All repos →". */
export function QuietLink({
  href,
  onClick,
  children,
  className,
}: {
  href?: string;
  onClick?: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const cls = cn(
    "cursor-pointer text-[12.5px] text-muted-foreground transition-colors hover:text-foreground",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={cls} {...(onClick ? { onClick } : {})}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} {...(onClick ? { onClick } : {})}>
      {children}
    </button>
  );
}

/* ── Status ─────────────────────────────────────────────────────────── */

export type Tone = "success" | "warning" | "error" | "info" | "neutral";

export const toneDot: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning-accent",
  error: "bg-destructive",
  info: "bg-info",
  neutral: "bg-foreground/30",
};

export const toneText: Record<Tone, string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-destructive",
  info: "text-info",
  neutral: "text-muted-foreground",
};

export const tonePill: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  error: "bg-destructive-soft text-destructive",
  info: "bg-info-soft text-info",
  neutral: "bg-secondary text-muted-foreground",
};

/** Small round status dot; `live` pulses it (running/streaming states). */
export function StatusDot({
  tone = "neutral",
  live = false,
  className,
}: {
  tone?: Tone;
  live?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-block h-[7px] w-[7px] shrink-0 rounded-full", toneDot[tone], live && "animate-livepulse", className)}
    />
  );
}

/** Dot + short status text, tinted by tone. */
export function StatusText({
  tone = "neutral",
  live,
  children,
  className,
}: {
  tone?: Tone;
  live?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", toneText[tone], className)}>
      <StatusDot tone={tone} live={live ?? false} />
      {children}
    </span>
  );
}

/** Rounded status pill (health, severity, run state). */
export function Pill({
  tone = "neutral",
  dot = false,
  live = false,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  live?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px]",
        tonePill[tone],
        className,
      )}
    >
      {dot ? <StatusDot tone={tone} live={live} className="h-1.5 w-1.5" /> : null}
      {children}
    </span>
  );
}

/* ── Stat cards ─────────────────────────────────────────────────────── */

/** Kicker label + big serif number + optional unit and status line. */
export function StatCard({
  label,
  value,
  unit,
  footer,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  unit?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border bg-card px-[22px] py-5", className)}>
      <Kicker>{label}</Kicker>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="font-serif text-[34px] font-medium leading-none">{value}</span>
        {unit ? <span className="text-[13px] text-muted-foreground">{unit}</span> : null}
      </div>
      {footer ? <div className="mt-3 text-[12.5px]">{footer}</div> : null}
    </div>
  );
}

/** Inline serif stat for header strips: number over caption, right-aligned. */
export function HeaderStat({
  value,
  caption,
  tone,
  className,
}: {
  value: React.ReactNode;
  caption: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("text-right", className)}>
      <div className={cn("font-serif text-[22px] font-medium leading-tight", tone && toneText[tone])}>{value}</div>
      <div className="text-[11.5px] text-muted-foreground/85">{caption}</div>
    </div>
  );
}

/* ── Filter chips ───────────────────────────────────────────────────── */

/** Filter pill: black when active, hairline white otherwise. */
export function Chip({
  active = false,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-[13px] py-[5px] text-[12.5px] transition-colors",
        active
          ? "border-primary bg-primary font-medium text-primary-foreground"
          : "border-border bg-card text-muted-foreground hover:border-foreground/25 hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** Chip row: wraps on desktop, swipes horizontally on mobile. */
export function ChipRow({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "-mx-5 flex items-center gap-[7px] overflow-x-auto px-5 scrollbar-none sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0",
        className,
      )}
      {...props}
    />
  );
}

/** Thin vertical divider between chip groups. */
export function ChipDivider() {
  return <span aria-hidden className="mx-1 h-[18px] w-px shrink-0 bg-border" />;
}

/* ── List cards & rows ──────────────────────────────────────────────── */

/** White card that stacks `ListRow`s with hairline dividers. */
export function ListCard({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-hidden rounded-xl border bg-card", className)} {...props} />;
}

/** Card header row: 13.5px semibold title + optional quiet link. */
export function ListCardHeader({
  title,
  action,
  className,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between px-5 pb-3 pt-4", className)}>
      <span className="text-[13.5px] font-semibold">{title}</span>
      {action}
    </div>
  );
}

/**
 * Interactive list row: quiet hover wash, reveals a trailing chevron.
 * Renders a Link when `href` is set, a button when `onClick` is set,
 * otherwise a plain div.
 */
export function ListRow({
  href,
  onClick,
  chevron = false,
  className,
  children,
}: {
  href?: string;
  onClick?: () => void;
  chevron?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const interactive = Boolean(href || onClick);
  const cls = cn(
    "group flex w-full items-center gap-3 border-t border-border/50 px-5 py-3 text-left first:border-t-0",
    interactive && "cursor-pointer transition-colors duration-100 hover:bg-muted",
    className,
  );
  const body = (
    <>
      {children}
      {chevron ? <RowChevron /> : null}
    </>
  );
  if (href) {
    return (
      <Link href={href} {...(onClick ? { onClick } : {})} className={cls}>
        {body}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cls}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

/** Trailing chevron that fades/slides in on row hover (parent needs `group`). */
export function RowChevron({ className }: { className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        "ml-auto h-3.5 w-3.5 shrink-0 -translate-x-[3px] text-muted-foreground/70 opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100",
        className,
      )}
    />
  );
}

/* ── Callouts & meters ──────────────────────────────────────────────── */

/** Amber (or red) attention banner with an optional trailing action. */
export function AttentionBanner({
  tone = "warning",
  action,
  className,
  children,
}: {
  tone?: "warning" | "error";
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4 text-[13px] sm:flex-row sm:items-center sm:gap-3 sm:px-5",
        tone === "warning"
          ? "border-warning-accent/40 bg-warning-wash text-[#7A6C4E] dark:text-warning"
          : "border-destructive/30 bg-destructive-wash text-destructive",
        className,
      )}
    >
      <StatusDot tone={tone === "warning" ? "warning" : "error"} className="hidden sm:inline-block" />
      <span className="min-w-0 flex-1">{children}</span>
      {action ? <span className="shrink-0 sm:ml-auto">{action}</span> : null}
    </div>
  );
}

/** Thin horizontal meter (usage bars, readiness scores). */
export function MeterBar({
  percent,
  tone,
  barClassName,
  className,
}: {
  percent: number;
  tone?: Tone;
  barClassName?: string;
  className?: string;
}) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-[3px] bg-[#EDEDED] dark:bg-secondary", className)}>
      <span
        className={cn("block h-full rounded-[3px] bg-[#A98A6A]", tone && toneDot[tone], barClassName)}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/** Segmented run progress: solid done segment + striped running segment. */
export function RunProgress({
  donePercent,
  runningPercent = 0,
  className,
}: {
  donePercent: number;
  runningPercent?: number;
  className?: string;
}) {
  return (
    <div className={cn("flex h-1.5 overflow-hidden rounded-[3px] bg-[#EDEDED] dark:bg-secondary", className)}>
      <span className="bg-[#7FA6E0]" style={{ width: `${Math.max(0, Math.min(100, donePercent))}%` }} />
      {runningPercent > 0 ? (
        <span className="runbar bg-[#C4D6F0]" style={{ width: `${Math.max(0, Math.min(100, runningPercent))}%` }} />
      ) : null}
    </div>
  );
}

/* ── Avatars ────────────────────────────────────────────────────────── */

const AVATAR_PALETTES = [
  { bg: "#E8DFCE", fg: "#7A6C4E" }, // sand
  { bg: "#DDE3D6", fg: "#5C6B50" }, // sage
  { bg: "#D9E2E8", fg: "#4E6473" }, // slate
  { bg: "#E3DBE8", fg: "#6E5C7A" }, // mauve
  { bg: "#E8D9D3", fg: "#7A5C50" }, // clay
  { bg: "#D6E3E0", fg: "#4E6B64" }, // teal
] as const;

/** Stable muted palette for a team/owner name. */
export function ownerPalette(name: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return AVATAR_PALETTES[Math.abs(hash) % AVATAR_PALETTES.length] ?? { bg: "#E8DFCE", fg: "#7A6C4E" };
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s·_-]+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  const second = parts[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
}

/** Round/rounded initials avatar in the muted Northwind palettes. */
export function OwnerAvatar({
  name,
  size = 18,
  shape = "circle",
  unowned = false,
  className,
}: {
  name: string;
  size?: number;
  shape?: "circle" | "square";
  unowned?: boolean;
  className?: string;
}) {
  const palette = ownerPalette(name);
  const radius = shape === "circle" ? "50%" : Math.round(size * 0.28);
  if (unowned) {
    return (
      <span
        aria-hidden
        className={cn("grid shrink-0 place-items-center border border-dashed border-foreground/25 font-bold text-muted-foreground", className)}
        style={{ width: size, height: size, borderRadius: radius, fontSize: Math.max(8, size * 0.47) }}
      >
        ?
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center font-bold", className)}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: palette.bg,
        color: palette.fg,
        fontSize: Math.max(8, size * 0.47),
      }}
    >
      {initialsOf(name)}
    </span>
  );
}

/** Neutral gray person avatar (members, actors). */
export function PersonAvatar({
  name,
  size = 26,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("grid shrink-0 place-items-center rounded-full bg-[#E0E0E0] font-semibold text-[#555555] dark:bg-secondary dark:text-secondary-foreground", className)}
      style={{ width: size, height: size, fontSize: Math.max(8, size * 0.42) }}
    >
      {initialsOf(name)}
    </span>
  );
}

/* ── Misc ───────────────────────────────────────────────────────────── */

/** Mono entity ref line: `component:default/checkout-api`. */
export function MonoRef({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("font-mono text-[11px] text-muted-foreground/85", className)} {...props} />;
}

/** Dashed footnote card (docs hint, empty guidance). */
export function DashedNote({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-dashed border-border bg-transparent px-5 py-[18px] text-[13px] leading-relaxed text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
