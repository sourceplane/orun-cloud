/**
 * Catalog portal header (saas-catalog-portal CP1).
 * Eyebrow · title · description · Import / Register actions — matching the
 * design's title block.
 */

import * as React from "react";
import { Download, Plus } from "lucide-react";

export function CatalogHeader({
  onImport,
  onRegister,
}: {
  onImport?: () => void;
  onRegister?: () => void;
}) {
  return (
    <div className="flex items-end gap-4">
      <div className="min-w-0">
        <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-[#f59e0b]">
          Service catalog
        </div>
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em] text-[#fafafa]">All services</h1>
        <p className="mt-1.5 max-w-[560px] text-[13px] text-[#71717a]">
          The org-wide component graph merged across every repo — ownership, production-readiness and live
          health in one place.
        </p>
      </div>
      <div className="ml-auto flex shrink-0 gap-2.5">
        <button
          type="button"
          onClick={onImport}
          className="flex h-[34px] items-center gap-1.5 rounded-lg border border-[#232327] bg-transparent px-[13px] text-[13px] font-medium text-[#d4d4d8] transition-colors hover:border-[#3a3a40]"
        >
          <Download className="h-3.5 w-3.5" />
          Import
        </button>
        <button
          type="button"
          onClick={onRegister}
          className="flex h-[34px] items-center gap-1.5 rounded-lg border border-[#f59e0b] bg-[#f59e0b] px-3.5 text-[13px] font-semibold text-[#1a1206] transition-colors hover:brightness-110"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
          Register service
        </button>
      </div>
    </div>
  );
}
