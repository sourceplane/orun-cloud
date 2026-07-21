"use client";

// The dispatch.copilot feature flag (saas-copilot-surface CX3/CX6, lock 7):
// org-scoped setting, default OFF. Flag off = the native thread renders
// exactly as before — the kill switch is a settings write, zero data loss
// (the DO rows were always the truth).

import * as React from "react";
import { wrap } from "@/lib/api";
import { qk, useApiQuery } from "@/lib/query";
import { useSession } from "@/lib/session";

export const COPILOT_FLAG_KEY = "dispatch.copilot";

export function useCopilotFlag(orgId: string): boolean {
  const { client } = useSession();
  const scope = React.useMemo(() => ({ kind: "organization" as const, orgId }), [orgId]);
  const settings = useApiQuery(qk.configSettings(`org:${orgId}`), () => wrap(async () => client.config.listSettings(scope)));
  const entry = (settings.data?.settings ?? []).find((s) => s.key === COPILOT_FLAG_KEY);
  return typeof entry?.value === "string" && ["on", "true", "1"].includes(entry.value);
}
