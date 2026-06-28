/**
 * Path glyph renderer for the catalog portal (saas-catalog-portal CP1).
 *
 * The view-model hands components a raw SVG `path d` for data-driven glyphs
 * (kind icons, check marks). This wraps it in the design's standard 24×24
 * stroked SVG so callers stay declarative. `currentColor` lets the parent set
 * the stroke via text colour.
 */

import * as React from "react";

export function PathIcon({
  d,
  size = 16,
  strokeWidth = 1.8,
  className,
}: {
  d: string;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
