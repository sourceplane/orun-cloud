"use client";

import * as React from "react";

/**
 * Track a CSS media query (PERF G4). Backed by `useSyncExternalStore` so it
 * reflects the real `matchMedia` result as soon as the client takes over —
 * reducing the wide-screen layout flash the old effect-then-setState hook had —
 * while still returning a stable server snapshot (`false`) during SSR/hydration,
 * which a naive lazy `useState(() => matchMedia(...))` would tear on.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = () =>
    typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(query).matches;
  const getServerSnapshot = () => false;
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
