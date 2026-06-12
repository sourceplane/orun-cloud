import { redirect } from "next/navigation";

export default function OrgRoot({ params }: { params: { orgSlug: string } }) {
  redirect(`/orgs/${params.orgSlug}/projects`);
}
