"use client";

// The Docs hub (saas-catalog-docs CD5) — the org-wide library of git-authored
// catalog docs: every entity's overview + pages, indexed at projection and
// browsable by kind/role/search. A thin route wrapper around `DocsHub`.

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { DocsHub } from "@/components/docs/docs-hub";

export default function DocsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <DocsHub orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
