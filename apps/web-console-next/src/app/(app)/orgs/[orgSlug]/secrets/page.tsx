"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { SecretsConsole } from "@/components/config/secrets-console";

/**
 * The dedicated Secrets & Config home. Org-scoped; the surface itself owns the
 * Workspace / Project / Environment scope selection (shareable via the
 * `?project=&env=` query params).
 */
export default function SecretsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return (
    <OrgScope slug={slug}>
      {(org) => <SecretsConsole orgId={org.id} />}
    </OrgScope>
  );
}
