"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { usePalette } from "./command-palette";

/**
 * "Find…" search at the top of the sidebar — opens the ⌘K command palette
 * (search + navigation + actions). Mirrors Vercel's sidebar search field.
 */
export function SidebarFind({ onOpen }: { onOpen?: () => void } = {}) {
  const palette = usePalette();
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.();
        palette.open();
      }}
      className="flex w-full items-center gap-2 rounded-[9px] border border-border bg-muted px-[9px] py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Search className="h-[13px] w-[13px]" />
      <span className="flex-1 text-left">Find anything</span>
      <kbd className="rounded border border-border bg-card px-[5px] py-px font-mono text-[10px] text-muted-foreground/70">
        ⌘K
      </kbd>
    </button>
  );
}
