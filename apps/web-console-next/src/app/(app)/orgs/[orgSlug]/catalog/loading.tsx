// Instant route-transition shell for the catalog index (PERF G1). Rendered by
// Next's Suspense boundary the moment navigation starts — before the client
// page code loads/hydrates — so switching to the catalog never shows a blank
// frame. The portal swaps in its own data skeletons once mounted.

import { Skeleton } from "@/components/ui/skeleton";

export default function CatalogLoading() {
  return (
    <div className="flex flex-col gap-4 md:h-[calc(100dvh-3rem)] md:gap-[18px] md:overflow-hidden" aria-hidden>
      {/* title + metric tiles */}
      <div className="flex shrink-0 flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-9 w-28 rounded-lg" />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[68px] w-full rounded-xl" />
          ))}
        </div>
      </div>
      {/* toolbar */}
      <Skeleton className="h-11 w-full shrink-0 rounded-lg md:h-[34px] md:max-w-2xl" />
      {/* table frame */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-[13px] border border-[#1a1a1e] bg-[#0c0c0f] p-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg bg-[#161619]" />
        ))}
      </div>
    </div>
  );
}
