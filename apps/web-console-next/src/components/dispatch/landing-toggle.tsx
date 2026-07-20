"use client";

// The landing preference toggle (saas-dispatch DX3): rendered on the demoted
// Overview so a workspace that lived there can reclaim its landing — the
// front-door swap is a default, never a lock-in.

import * as React from "react";
import { Button } from "@/components/ui/button";
import { readLanding, writeLanding, type Landing } from "@/lib/dispatch/landing";

export function LandingToggle({ orgSlug }: { orgSlug: string }) {
  const [landing, setLanding] = React.useState<Landing>("dispatch");
  React.useEffect(() => {
    setLanding(readLanding(window.localStorage, orgSlug));
  }, [orgSlug]);

  function set(next: Landing) {
    writeLanding(window.localStorage, orgSlug, next);
    setLanding(next);
  }

  return landing === "overview" ? (
    <Button size="sm" variant="ghost" onClick={() => set("dispatch")}>
      Make Dispatch my landing
    </Button>
  ) : (
    <Button size="sm" variant="ghost" onClick={() => set("overview")}>
      Make Overview my landing
    </Button>
  );
}
