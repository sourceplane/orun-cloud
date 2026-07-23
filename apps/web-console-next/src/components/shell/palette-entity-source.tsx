"use client";

/**
 * Feeds ⌘K from data (IC7, delivers PX6): catalog entities, the org doc
 * index, teams, and already-read secret names become palette commands.
 *
 * Sourcing rules:
 * - **Reads ride the shared query cache** (`qk.orgCatalog` / `qk.orgDocs` /
 *   `qk.teams`) — the same entries the surfaces themselves use, persisted by
 *   IC3, so a warm cache answers instantly with zero requests.
 * - **Lazy first-fetch**: nothing fetches at boot; the first palette OPEN in
 *   an org primes any cold entries (`ensureQueryData`, deduped with any
 *   in-flight surface fetch). The queryFns mirror the owning surfaces
 *   byte-for-byte so the cache entries stay shape-compatible.
 * - **Secrets never cold-fetch** and are exempt from persistence (D3): only
 *   names the Secrets surface already loaded this session appear.
 * - **Recents first**: entity-ish commands run recently on this device rank
 *   ahead of the rest (recency list re-read on every open).
 */

import * as React from "react";
import { useParams } from "next/navigation";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import type { OrgCatalogEntity, CatalogDoc } from "@saas/contracts/state";
import type { PublicTeam } from "@saas/contracts/membership";
import { wrap, type ApiResult } from "@/lib/api";
import { qk } from "@/lib/query";
import { useSession } from "@/lib/session";
import { collectOrgCatalog } from "@/lib/catalog-portal/fetch";
import { usePalette, useRegisterCommands } from "@/components/shell/command-palette";
import {
  entityCommands,
  docCommands,
  teamCommands,
  secretCommands,
  rankByRecency,
  readRecentCommandIds,
} from "@/lib/palette/entity-commands";

const ORG_DOCS_PAGE_LIMIT = 100;
const ORG_DOCS_MAX_PAGES = 5;

function unwrapOrThrow<T>(r: ApiResult<T>): T {
  if (!r.ok) throw r.error;
  return r.data;
}

export function PaletteEntitySource() {
  const params = useParams<{ orgSlug?: string }>();
  const orgSlug = params?.orgSlug ?? null;
  const { client, token } = useSession();
  const qc = useQueryClient();
  const { isOpen } = usePalette();

  // Slug → org id through the shared orgs cache (no extra fetch: the shell
  // always has this entry; enabled:false keeps this a pure cache subscription).
  const orgs = useQuery<{ id: string; slug: string }[]>({ queryKey: qk.orgs(), enabled: false });
  const orgId = React.useMemo(
    () => orgs.data?.find((o) => o.slug === orgSlug)?.id ?? null,
    [orgs.data, orgSlug],
  );

  // Pure cache subscriptions — data appears when a surface (or our own
  // palette-open primer below) populates the shared entries.
  const entities = useQuery<OrgCatalogEntity[]>({
    queryKey: orgId ? qk.orgCatalog(orgId) : ["orgCatalog", "none"],
    enabled: false,
  });
  const docs = useQuery<CatalogDoc[]>({
    queryKey: orgId ? qk.orgDocs(orgId) : ["orgDocs", "none"],
    enabled: false,
  });
  const teams = useQuery<PublicTeam[]>({
    queryKey: orgId ? qk.teams(orgId) : ["teams", "none"],
    enabled: false,
  });

  // Lazy first-fetch: prime cold entries on palette open (once per org+open;
  // ensureQueryData dedupes against cache + in-flight surface fetches).
  const primedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!isOpen || !orgId || !token || primedFor.current === orgId) return;
    primedFor.current = orgId;
    void qc
      .ensureQueryData({
        queryKey: qk.orgCatalog(orgId),
        queryFn: async () =>
          unwrapOrThrow(
            await wrap(() => collectOrgCatalog((query) => client.state.listOrgCatalogEntities(orgId, query))),
          ),
      })
      .catch(() => {});
    void qc
      .ensureQueryData({
        queryKey: qk.orgDocs(orgId),
        queryFn: async () =>
          unwrapOrThrow(
            await wrap(async () => {
              const all: CatalogDoc[] = [];
              let cursor: string | null = null;
              for (let i = 0; i < ORG_DOCS_MAX_PAGES; i++) {
                const page = await client.state.listCatalogDocs(orgId, {
                  limit: ORG_DOCS_PAGE_LIMIT,
                  ...(cursor ? { cursor } : {}),
                });
                all.push(...page.docs);
                if (!page.nextCursor) break;
                cursor = `${page.nextCursor.createdAt}|${page.nextCursor.id}`;
              }
              return all;
            }),
          ),
      })
      .catch(() => {});
    void qc
      .ensureQueryData({
        queryKey: qk.teams(orgId),
        queryFn: async () => unwrapOrThrow(await wrap(async () => (await client.teams.listTeams(orgId)).teams)),
      })
      .catch(() => {});
  }, [isOpen, orgId, token, qc, client]);

  // Recents re-read on each open so this session's runs re-rank immediately.
  const [recents, setRecents] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (isOpen) setRecents(readRecentCommandIds());
  }, [isOpen]);

  // Secret names: in-memory-only snapshot of whatever the Secrets surface
  // already loaded (any scope). Non-reactive by design — refreshed per open.
  const [secretNames, setSecretNames] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!isOpen) return;
    const names: string[] = [];
    for (const [, data] of qc.getQueriesData<Array<{ name?: string }>>({ queryKey: ["configSecrets"] })) {
      for (const row of data ?? []) if (typeof row?.name === "string") names.push(row.name);
    }
    setSecretNames(names);
  }, [isOpen, qc]);

  const commands = React.useMemo(() => {
    if (!orgSlug) return [];
    const all = [
      ...entityCommands(orgSlug, entities.data ?? []),
      ...docCommands(orgSlug, docs.data ?? []),
      ...teamCommands(orgSlug, teams.data ?? []),
      ...secretCommands(orgSlug, secretNames),
    ];
    return rankByRecency(all, recents);
  }, [orgSlug, entities.data, docs.data, teams.data, secretNames, recents]);

  useRegisterCommands(commands);
  return null;
}
