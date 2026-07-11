"use client";

import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { InitiativesWorkbench } from "@/components/work/initiatives-workbench";

export default function InitiativesPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <InitiativesWorkbench orgId={org.id} />}</OrgScope>;
}
