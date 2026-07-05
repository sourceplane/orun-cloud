"use client";

// The doc reader route (saas-catalog-docs CD5): one git-authored document,
// identity-addressed by (entityKey, docKey) so links survive content changes.
// A thin wrapper around `DocReader`; `bare` because the reader renders its own
// breadcrumb (Docs / entity / title).

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { DocReader } from "@/components/docs/doc-reader";

export default function DocReaderPage() {
  const params = useParams<{ orgSlug: string; entityKey: string; docKey: string }>();
  const slug = params?.orgSlug ?? "";
  const entityKey = params?.entityKey ?? "";
  const docKey = decodeURIComponent(params?.docKey ?? "");
  return (
    <OrgScope slug={slug} bare>
      {(org) => <DocReader orgId={org.id} orgSlug={slug} entityKey={entityKey} docKey={docKey} />}
    </OrgScope>
  );
}
