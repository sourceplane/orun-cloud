"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { z } from "zod";
import { Plus, Users } from "lucide-react";
import { OrgScope } from "@/components/shell/org-scope";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ZodForm } from "@/components/ui/zod-form";
import { wrap } from "@/lib/api";
import { useSession } from "@/lib/session";
import { useApiQuery, qk } from "@/lib/query";
import { useToast } from "@/components/ui/toast";
import type { PublicTeam } from "@saas/contracts/membership";

const schema = z.object({
  name: z.string().min(1, "Enter a team name"),
  slug: z.string().optional(),
});

export default function TeamsPage() {
  const params = useParams<{ orgSlug: string }>();
  const slug = params?.orgSlug ?? "";
  return <OrgScope slug={slug}>{(org) => <Inner orgId={org.id} slug={slug} />}</OrgScope>;
}

function Inner({ orgId, slug }: { orgId: string; slug: string }) {
  const { client } = useSession();
  const { toast } = useToast();
  const [open, setOpen] = React.useState(false);
  const [pendingDelete, setPendingDelete] = React.useState<{ id: string; name: string } | null>(null);

  const teams = useApiQuery(qk.teams(orgId), () =>
    wrap(async () => (await client.teams.listTeams(orgId)).teams),
  );

  const deleteTeam = async (id: string) => {
    const r = await wrap(() => client.teams.deleteTeam(orgId, id));
    if (!r.ok) {
      toast({ kind: "error", title: "Delete failed", description: r.error.message });
      return;
    }
    toast({ kind: "success", title: "Team deleted" });
    teams.reload();
  };

  return (
    <div className="space-y-5">
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="Delete team"
        description="The team is removed and all of its role grants are revoked. Members lose any access they held through this team."
        resourceName={pendingDelete?.name}
        confirmLabel="Delete team"
        onConfirm={() => (pendingDelete ? deleteTeam(pendingDelete.id) : undefined)}
      />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Teams</h1>
          <p className="text-sm text-muted-foreground">
            Account-owned groups of users and service principals you grant roles to. A role granted to a
            team reaches every member; grant it at account scope to cover every workspace.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1.5 size-4" /> New team
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create team</DialogTitle>
              <DialogDescription>Teams are owned by the account and can be granted roles on any workspace.</DialogDescription>
            </DialogHeader>
            <ZodForm
              schema={schema}
              defaultValues={{ name: "", slug: "" }}
              fields={[
                { name: "name", label: "Name", placeholder: "Platform Engineering" },
                { name: "slug", label: "Slug", hint: "Optional — derived from the name if omitted" },
              ]}
              submitLabel="Create team"
              cancel={{ label: "Cancel", onClick: () => setOpen(false) }}
              onSubmit={async (v) => {
                const r = await wrap(() =>
                  client.teams.createTeam(orgId, { name: v.name, ...(v.slug ? { slug: v.slug } : {}) }),
                );
                if (!r.ok) {
                  toast({ kind: "error", title: "Create failed", description: r.error.message });
                  return;
                }
                toast({ kind: "success", title: "Team created" });
                setOpen(false);
                teams.reload();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      {teams.loading ? (
        <Card>
          <CardContent className="pt-6 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </CardContent>
        </Card>
      ) : teams.error ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-destructive">{teams.error.code}</CardTitle>
            <CardDescription>{teams.error.message}</CardDescription>
          </CardHeader>
        </Card>
      ) : !teams.data || teams.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No teams"
          description="Create a team to grant a role to a group of people at once."
          primaryAction={{ label: "New team", onClick: () => setOpen(true) }}
        />
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.data.map((t: PublicTeam) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">
                    <Link href={`/orgs/${slug}/settings/teams/${t.id}`} className="hover:underline">
                      {t.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{t.slug}</TableCell>
                  <TableCell>
                    <Badge variant={t.status === "active" ? "default" : "secondary"}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPendingDelete({ id: t.id, name: t.name })}
                    >
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
