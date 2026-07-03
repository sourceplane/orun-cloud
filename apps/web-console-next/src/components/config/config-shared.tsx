"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/** Shared loading/error affordances for the config surface and its panels. */

export function ListSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

export function LoadError({ title, message }: { title: string; message: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="text-sm font-medium text-destructive">{title}</div>
        <div className="text-xs text-muted-foreground">{message}</div>
      </CardContent>
    </Card>
  );
}
