import type { InternalTeamMembersResponse } from "@saas/contracts/membership";
import type { ResolveEmailsResponse } from "@saas/contracts/auth";

/**
 * teams-collaboration TC1 — expand a team notification target to its current
 * members' delivery emails.
 *
 * Two hops, both service-binding only:
 *   1. membership-worker → the active roster (subject ids),
 *   2. identity-worker  → each *user* subject id → email.
 *
 * The roster is read live at send time, so a membership change is reflected on
 * the next send with no backfill. Only `user` subjects can be emailed —
 * service-principal members have no delivery identity and are dropped.
 */

/** One resolved delivery target for a team member (TC1). */
export interface TeamRecipient {
  subjectId: string;
  /** Lower-cased delivery email. */
  address: string;
}

export type ExpandTeamResult =
  | { ok: true; recipients: TeamRecipient[] }
  | { ok: false; reason: "unavailable" };

async function readData(response: Response): Promise<unknown | null> {
  if (!response.ok) return null;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("data" in parsed)) return null;
  return (parsed as { data: unknown }).data;
}

/** Fetch the active roster's subject ids (user subjects only). */
async function fetchTeamMemberSubjectIds(
  membershipWorker: Fetcher,
  teamId: string,
  requestId: string,
): Promise<string[] | null> {
  let response: Response;
  try {
    response = await membershipWorker.fetch("http://membership-worker/v1/internal/membership/team-members", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ teamId }),
    });
  } catch {
    return null;
  }
  const data = await readData(response);
  if (!data || typeof data !== "object" || !("members" in data)) return null;
  const typed = data as InternalTeamMembersResponse;
  if (!Array.isArray(typed.members)) return null;
  return typed.members.filter((m) => m.subjectType === "user").map((m) => m.subjectId);
}

/** Resolve a batch of user subject ids to delivery emails. */
async function fetchMemberEmails(
  identityWorker: Fetcher,
  subjectIds: string[],
  requestId: string,
): Promise<Map<string, string> | null> {
  let response: Response;
  try {
    response = await identityWorker.fetch("http://identity-worker/v1/internal/identity/resolve-emails", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId },
      body: JSON.stringify({ subjectIds }),
    });
  } catch {
    return null;
  }
  const data = await readData(response);
  if (!data || typeof data !== "object" || !("users" in data)) return null;
  const typed = data as ResolveEmailsResponse;
  if (!Array.isArray(typed.users)) return null;
  const map = new Map<string, string>();
  for (const u of typed.users) {
    if (typeof u.subjectId === "string" && typeof u.email === "string" && u.email.length > 0) {
      map.set(u.subjectId, u.email.toLowerCase());
    }
  }
  return map;
}

/**
 * Expand a team target to its deliverable recipients. Returns `unavailable`
 * when either dependency can't be reached (the enqueue surfaces a 503 rather
 * than silently dropping the send). An empty `recipients` array is a *valid*
 * result — a team with no active members that resolve to an email.
 */
export async function expandTeamRecipients(
  membershipWorker: Fetcher | undefined,
  identityWorker: Fetcher | undefined,
  teamId: string,
  requestId: string,
): Promise<ExpandTeamResult> {
  if (!membershipWorker || !identityWorker) {
    return { ok: false, reason: "unavailable" };
  }

  const subjectIds = await fetchTeamMemberSubjectIds(membershipWorker, teamId, requestId);
  if (subjectIds === null) return { ok: false, reason: "unavailable" };
  if (subjectIds.length === 0) return { ok: true, recipients: [] };

  const emails = await fetchMemberEmails(identityWorker, subjectIds, requestId);
  if (emails === null) return { ok: false, reason: "unavailable" };

  // Preserve roster order; drop members with no resolvable email. De-dupe on
  // address so two subjects sharing an email don't double-send.
  const seen = new Set<string>();
  const recipients: TeamRecipient[] = [];
  for (const subjectId of subjectIds) {
    const address = emails.get(subjectId);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    recipients.push({ subjectId, address });
  }
  return { ok: true, recipients };
}
