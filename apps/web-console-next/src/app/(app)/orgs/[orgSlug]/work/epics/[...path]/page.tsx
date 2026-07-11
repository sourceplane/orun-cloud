"use client";

// Epic + milestone drill-down. Epic keys may contain slashes (imported
// corpora use path-like keys), so one catch-all parses both:
//   /work/epics/<epic…>                  → the epic page
//   /work/epics/<epic…>/milestones/<key> → one milestone
import { useParams } from "next/navigation";
import { OrgScope } from "@/components/shell/org-scope";
import { EpicDetail } from "@/components/work/epic-detail";
import { MilestoneDetail } from "@/components/work/milestone-detail";

export default function EpicPage() {
  const params = useParams<{ orgSlug: string; path: string[] }>();
  const slug = params?.orgSlug ?? "";
  const parts = (params?.path ?? []).map(decodeURIComponent);
  const msIdx = parts.lastIndexOf("milestones");
  const isMilestone = msIdx > 0 && msIdx === parts.length - 2;
  const epicKey = (isMilestone ? parts.slice(0, msIdx) : parts).join("/");
  const milestoneKey = isMilestone ? parts[parts.length - 1]! : null;
  return (
    <OrgScope slug={slug}>
      {(org) =>
        milestoneKey ? (
          <MilestoneDetail orgId={org.id} epicKey={epicKey} milestoneKey={milestoneKey} />
        ) : (
          <EpicDetail orgId={org.id} epicKey={epicKey} />
        )
      }
    </OrgScope>
  );
}
