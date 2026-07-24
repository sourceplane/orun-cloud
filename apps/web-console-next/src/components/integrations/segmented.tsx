"use client";

/**
 * Segmented control (saas-integrations-console IX2) — the pill-segment toggle
 * the detail page uses for All/Selected repositories, Open-to-all/By-invitation,
 * and brokered/rotated secret views. Active segment = ink fill; the rest quiet.
 * Northwind has no segmented primitive; this is the shared one.
 */

import * as React from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
  className,
}: {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  "aria-label"?: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("inline-flex shrink-0 items-center rounded-lg border bg-card p-0.5", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
