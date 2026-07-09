"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { TriageWorkbench } from "@/components/work/triage-workbench";

export default function WorkTriagePage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <TriageWorkbench orgId={org.id} orgSlug={slug} />}</OrgScope>;
}
