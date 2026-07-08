"use client";

import Link from "next/link";
import { cn } from "@/lib/cn";
import { buildPersonalNav } from "@/components/shell/personal-nav";

/** Sub-navigation shared by the personal account pages (saas-settings-ia SI2). */
export function AccountTabs({ active }: { active: "profile" | "security" | "sessions" }) {
  return (
    <div className="flex items-center gap-1 border-b">
      {buildPersonalNav().map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
            t.key === active
              ? "border-primary font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}
