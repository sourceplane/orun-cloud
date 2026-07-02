import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-transition skeleton for the Workspace Overview — mirrors the three
 * bands (identity, signal row, two-column body) so the shell paints before the
 * client bundle hydrates.
 */
export default function OverviewLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-32 w-full rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-64 w-full rounded-xl lg:col-span-2" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}
