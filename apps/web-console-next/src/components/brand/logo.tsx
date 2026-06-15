import * as React from "react";
import { cn } from "@/lib/cn";
import { PRODUCT_NAME } from "@/lib/app-config";

/**
 * The orun brand mark: an amber sunrise arc over a horizon line — the same glyph
 * used on orun.dev (nav + favicon). The arc is the constant brand amber; the
 * horizon line inherits `currentColor`, so it sits correctly on both the dark
 * (light line) and light (dark line) console themes.
 */
export function OrunMark({
  className,
  size = 22,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M4 22a12 12 0 0 1 24 0"
        stroke="#f59e0b"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
      <line
        x1="3"
        y1="27"
        x2="29"
        y2="27"
        stroke="currentColor"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Brand lockup — the mark plus an optional wordmark — for the console's
 * unauthenticated/entry surfaces (login, onboarding, 404). Mirrors the
 * landing-page header so the two products feel continuous.
 */
export function Logo({
  className,
  markSize = 24,
  wordmark = true,
  label = PRODUCT_NAME,
}: {
  className?: string;
  markSize?: number;
  wordmark?: boolean;
  label?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5 text-foreground", className)}>
      <OrunMark size={markSize} />
      {wordmark && (
        <span className="text-[17px] font-semibold leading-none tracking-tight lowercase">
          {label}
        </span>
      )}
    </span>
  );
}
