"use client";

import * as React from "react";
import { cn } from "@/lib/cn";

export function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  // Northwind table: white card wrapper (12px radius), horizontal scroll on
  // small screens, hairline row dividers.
  return (
    <div className="relative w-full overflow-x-auto scrollbar-thin rounded-xl border bg-card">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}
export function THead(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className="[&_tr]:border-b [&_tr]:border-border/60 [&_tr:hover]:bg-transparent" {...props} />;
}
export function TBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className="[&_tr:last-child]:border-0" {...props} />;
}
export function TR({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        "border-b border-border/50 transition-colors duration-100 hover:bg-muted data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}
export function TH({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        "h-9 px-5 text-left align-middle text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground/85",
        className,
      )}
      {...props}
    />
  );
}
export function TD({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-5 py-3.5 align-middle", className)} {...props} />;
}

// Aliases for callers that prefer the long shadcn naming.
export {
  THead as TableHeader,
  TBody as TableBody,
  TR as TableRow,
  TH as TableHead,
  TD as TableCell,
};
