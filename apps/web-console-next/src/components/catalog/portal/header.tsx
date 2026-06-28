/**
 * Catalog portal header (saas-catalog-portal CP1).
 * A compact title row — "All services" inline with the Import / Register
 * actions — so the list reclaims the vertical space the eyebrow/description used.
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
    <div className="flex items-center gap-4">
      <h1 className="m-0 min-w-0 truncate text-[19px] font-semibold tracking-[-0.01em] text-[#fafafa]">
        All services
      </h1>
      <div className="ml-auto flex shrink-0 gap-2.5">
        <button
          type="button"
          onClick={onImport}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-[#232327] bg-transparent px-[13px] text-[13px] font-medium text-[#d4d4d8] transition-colors hover:border-[#3a3a40]"
        >
          <Download className="h-3.5 w-3.5" />
          Import
        </button>
        <button
          type="button"
          onClick={onRegister}
          className="flex h-8 items-center gap-1.5 rounded-lg border border-[#f59e0b] bg-[#f59e0b] px-3.5 text-[13px] font-semibold text-[#1a1206] transition-colors hover:brightness-110"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.4} />
          Register service
        </button>
      </div>
    </div>
  );
}
