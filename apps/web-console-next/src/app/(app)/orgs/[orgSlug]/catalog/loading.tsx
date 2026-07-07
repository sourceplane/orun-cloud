// Instant route-transition shell for the catalog index (PERF G1). Rendered by
// Next's Suspense boundary the moment navigation starts — before the client
// page code loads/hydrates — so switching to the catalog never shows a blank
// frame. The portal swaps in its own data skeletons once mounted.

import { Skeleton } from "@/components/ui/skeleton";
import { Screen } from "@/components/ui/northwind";

export default function CatalogLoading() {
  return (
    <Screen aria-hidden>
      {/* header */}
      <div className="flex items-end justify-between gap-5">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <Skeleton className="hidden h-[34px] w-[230px] rounded-[9px] sm:block" />
      </div>
      {/* chip row */}
      <div className="mt-[26px] flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-full" />
        ))}
      </div>
      {/* toolbar */}
      <Skeleton className="mt-3.5 h-[34px] w-full max-w-xl rounded-lg" />
      {/* table card */}
      <div className="mt-3.5 flex flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg bg-muted" />
        ))}
      </div>
    </Screen>
  );
}
