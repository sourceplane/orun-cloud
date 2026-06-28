// Instant route-transition shell for the catalog index (PERF G1). Rendered by
// Next's Suspense boundary the moment navigation starts — before the client
// page code loads/hydrates — so switching to the catalog never shows a blank
// frame. The portal swaps in its own data skeletons once mounted.

import { Skeleton } from "@/components/ui/skeleton";

export default function CatalogLoading() {
  return (
    <div className="flex h-[calc(100dvh-6rem)] flex-col gap-[18px] overflow-hidden" aria-hidden>
      {/* title + metric tiles */}
      <div className="flex shrink-0 flex-col gap-4">
        <div className="space-y-2">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      </div>
      {/* toolbar */}
      <Skeleton className="h-[34px] w-full max-w-2xl shrink-0 rounded-lg" />
      {/* table frame */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f] p-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg bg-[#161619]" />
        ))}
      </div>
    </div>
  );
}
