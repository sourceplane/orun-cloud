"use client";

import * as React from "react";

/**
 * Debounce a fast-changing value before it drives expensive work (PERF C4).
 *
 * The input stays controlled at full speed by its owner; this returns a value
 * that only settles `delayMs` after the last change, so heavy derived work
 * (filter → sort → group → decorate over the whole catalog) runs at most a few
 * times per second instead of on every keystroke.
 */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
