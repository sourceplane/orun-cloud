// Instant route-transition shell for the runs list (PERF G1).

import { Skeleton } from "@/components/ui/skeleton";

export default function RunsLoading() {
  return (
    <div className="space-y-6" aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </div>
      <div className="divide-y divide-border rounded-lg border bg-card">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
