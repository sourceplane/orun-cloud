// Instant route-transition shell for the projects list (PERF G1).

import { Screen } from "@/components/ui/northwind";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProjectsLoading() {
  return (
    <Screen aria-hidden>
      <div className="space-y-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-[32rem] max-w-full" />
      </div>
      <div className="mt-7 flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] w-full rounded-xl" />
        ))}
      </div>
    </Screen>
  );
}
