"use client";

/**
 * Northwind settings-content primitives.
 *
 * The Settings frame (layout.tsx) owns the page container, the serif "Settings"
 * heading, and the left nav / mobile chip row. These primitives encode the
 * *content* language of the settings mock (design/settings.html): a small
 * section heading + muted description, white cards, a two-column labeled form
 * grid, right-aligned save actions, identifier rows with copy, a danger-zone
 * card, and simple divided list rows.
 *
 * Everything here is presentation-only — pages keep their own hooks, queries,
 * and handlers and just drop this vocabulary in.
 */

import * as React from "react";
import { cn } from "@/lib/cn";

/* ── Section header ──────────────────────────────────────────────────── */

/** 15px/600 title + 12.5px muted description that opens each settings page. */
export function SettingsHeader({
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
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold leading-tight">{title}</h2>
        {description != null ? (
          <p className="mt-1.5 text-[12.5px] leading-normal text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2.5">{actions}</div> : null}
    </div>
  );
}

/* ── Cards ───────────────────────────────────────────────────────────── */

/**
 * White settings card: hairline border, radius 12px, ~p-[22px_24px]. The
 * first card after the header sits at mt-[18px]; stacked cards use mt-3.5.
 * `tone="danger"` paints the destructive variant.
 */
export function SettingsPanel({
  tone = "default",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { tone?: "default" | "danger" }) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card px-6 py-[22px]",
        tone === "danger" && "border-destructive/25",
        className,
      )}
      {...props}
    />
  );
}

/** A titled subsection inside a panel (e.g. "Identifiers"). */
export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("text-[13.5px] font-semibold", className)} {...props} />;
}

/* ── Forms ───────────────────────────────────────────────────────────── */

/** Two-column labeled input grid (single column on phones). */
export function FormGrid({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("grid gap-[18px] sm:grid-cols-2", className)} {...props} />;
}

/** 12.5px/500 field label stacked over its control. */
export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn("flex flex-col gap-[7px] text-[12.5px] font-medium", className)}>
      {label}
      {children}
    </label>
  );
}

/** Right-aligned action bar under a form (Save changes). */
export function FormActions({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-[18px] flex items-center justify-end gap-2.5", className)} {...props} />;
}

/* ── Identifier rows ─────────────────────────────────────────────────── */

/**
 * Muted identifier row: 12px label on the left, mono value + trailing control
 * (typically a CopyButton) on the right.
 */
export function IdentifierRow({
  label,
  value,
  action,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-[9px] border bg-muted px-3.5 py-2.5",
        className,
      )}
    >
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="truncate font-mono text-xs text-foreground">{value}</span>
        {action}
      </span>
    </div>
  );
}

/* ── Danger zone ─────────────────────────────────────────────────────── */

/** Destructive-tinted card: red title, muted body, outlined destructive action. */
export function DangerZone({
  title,
  description,
  action,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <SettingsPanel tone="danger" className={className}>
      <div className="text-[13.5px] font-semibold text-destructive">{title}</div>
      {description != null ? (
        <p className="mt-1.5 max-w-[440px] text-[12.5px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-3.5">{action}</div> : null}
    </SettingsPanel>
  );
}

/* ── List rows ───────────────────────────────────────────────────────── */

/**
 * A settings list row inside a `ListCard` (from northwind). Divided by a
 * hairline; hover-highlights when interactive. Prefer the northwind `ListRow`
 * for chevron/link rows; this is the quieter settings-list variant that keeps
 * inline action controls on the right.
 */
export function SettingsRow({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-border/60 px-5 py-[13px] first:border-t-0",
        className,
      )}
      {...props}
    />
  );
}
