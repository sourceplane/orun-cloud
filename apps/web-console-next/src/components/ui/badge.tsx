"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  // Northwind pill: fully rounded, soft tint fill, 11.5px text.
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] font-normal transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "border-transparent bg-info-soft text-link",
        secondary: "border-transparent bg-secondary text-muted-foreground",
        destructive: "border-transparent bg-destructive-soft text-destructive",
        warning: "border-transparent bg-warning-soft text-warning",
        success: "border-transparent bg-success-soft text-success",
        info: "border-transparent bg-info-soft text-info",
        outline: "border-border bg-card text-muted-foreground",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
