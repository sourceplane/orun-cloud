"use client";

import * as React from "react";
import { cn } from "@/lib/cn";
import { Button } from "./button";
import type { LucideIcon } from "lucide-react";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  primaryAction?: { label: string; onClick?: () => void; href?: string };
  secondaryAction?: { label: string; onClick?: () => void; href?: string };
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, primaryAction, secondaryAction, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        // Northwind empty state: quiet centered white card, hairline border.
        "flex flex-col items-center justify-center rounded-xl border bg-card px-6 py-14 text-center",
        className,
      )}
    >
      {Icon && (
        <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </div>
      )}
      <h3 className="text-[13.5px] font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-md text-[12.5px] leading-normal text-muted-foreground">{description}</p>
      )}
      {(primaryAction || secondaryAction) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {primaryAction &&
            (primaryAction.href ? (
              <Button asChild>
                <a href={primaryAction.href}>{primaryAction.label}</a>
              </Button>
            ) : (
              <Button onClick={primaryAction.onClick}>{primaryAction.label}</Button>
            ))}
          {secondaryAction &&
            (secondaryAction.href ? (
              <Button asChild variant="outline">
                <a href={secondaryAction.href}>{secondaryAction.label}</a>
              </Button>
            ) : (
              <Button variant="outline" onClick={secondaryAction.onClick}>
                {secondaryAction.label}
              </Button>
            ))}
        </div>
      )}
    </div>
  );
}
