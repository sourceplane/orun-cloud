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
    <div className="flex items-center gap-3 sm:gap-4">
      <h1 className="m-0 min-w-0 truncate text-[17px] font-semibold tracking-[-0.01em] text-foreground sm:text-[19px]">
        All services
      </h1>
      <div className="ml-auto flex shrink-0 gap-2 sm:gap-2.5">
        {/* Import collapses to an icon-only control on small screens to keep the
            primary "Register" action prominent without crowding the title. */}
        <button
          type="button"
          onClick={onImport}
          aria-label="Import"
          className="flex h-9 items-center gap-1.5 rounded-lg border border-border bg-transparent px-2.5 text-[13px] font-medium text-foreground/90 transition-colors hover:border-input sm:h-8 sm:px-[13px]"
        >
          <Download className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
          <span className="hidden sm:inline">Import</span>
        </button>
        <button
          type="button"
          onClick={onRegister}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-primary bg-primary px-3 text-[13px] font-semibold text-primary-foreground transition-colors hover:brightness-110 sm:h-8 sm:px-3.5"
        >
          <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" strokeWidth={2.4} />
          Register<span className="hidden sm:inline">&nbsp;service</span>
        </button>
      </div>
    </div>
  );
}
