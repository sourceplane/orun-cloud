---
title: Audit
description: Query the workspace audit log — filter parameters, the PublicAuditEntry shape, and cursor-based iteration over every page.
---

The **audit log** is the append-only record of who did what in a workspace — every state-changing action lands as an entry with actor, subject, and trace context. The API exposes one read endpoint per workspace; entries are returned newest-first with cursor pagination. For the model and retention behavior, see [Audit log](/platform/audit/audit-log).

## Endpoint

| Method | Path | Permission | Description |
|---|---|---|---|
| `GET` | `/v1/organizations/{orgId}/audit` | `audit.read` | List audit entries, filtered and cursor-paginated |

Audit reads use the more generous `audit` rate-limit family (120 requests/60 s per identity, 600 per workspace) — see [Rate limits](/api/rate-limits).

## Filter parameters

All filters are optional and combine with AND. Empty parameters are ignored; malformed ones return `422 validation_failed` before any query runs.

| Parameter | Type | Constraints | Description |
|---|---|---|---|
| `category` | string | lowercase letters, digits, `_ . -`; max 64 chars | Event category (e.g. `billing`) |
| `actorId` | string | 1–128 chars of `A-Za-z0-9 _ . : -` | The raw actor id recorded on the event |
| `actorType` | enum | `user`, `service_principal`, `workflow`, `system` | Kind of actor |
| `subjectKind` | string | 1–128 chars of `A-Za-z0-9 _ . : -` | Subject/resource kind (e.g. `project`, `member`) |
| `subjectId` | string | 1–128 chars of `A-Za-z0-9 _ . : -` | Subject/resource id |
| `eventType` | string | 1–128 chars of `A-Za-z0-9 _ . : -` | Audit action (e.g. `member.role_changed`) |
| `from` | timestamp | ISO-8601 with milliseconds, e.g. `2026-01-01T00:00:00.000Z` | Inclusive lower bound on `occurredAt` |
| `to` | timestamp | ISO-8601 with milliseconds | Inclusive upper bound on `occurredAt` |
| `limit` | integer | 1–100, default 50 | Page size |
| `cursor` | string | opaque | Continuation token from the previous page's `meta.cursor` |

Send the same filters on every page of a walk — the cursor is only valid for the query it was issued against.

## Query the log

```bash
curl "https://api.orun.dev/v1/organizations/org_1f6a3c9e/audit?eventType=member.role_changed&from=2026-06-01T00:00:00.000Z&limit=50" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "auditEntries": [
      {
        "id": "0d9c8b7a-6f5e-4d3c-2b1a-0f9e8d7c6b5a",
        "eventId": "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
        "orgId": "org_1f6a3c9e",
        "projectId": null,
        "environmentId": null,
        "actorType": "user",
        "actorId": "usr_9f8e7d6c",
        "eventType": "member.role_changed",
        "source": "membership-worker",
        "category": "membership",
        "description": "Member role changed",
        "subject": { "kind": "member", "id": "mem_8a7b6c5d", "name": null },
        "occurredAt": "2026-06-28T14:03:22.481Z",
        "requestId": "req_5c6d7e8f9a0b",
        "correlationId": null,
        "payload": { "role": "admin" }
      }
    ]
  },
  "meta": {
    "requestId": "req_6d7e8f9a0b1c",
    "cursor": "eyJ2IjoxLCJ0IjoiMjAyNi0wNi0yOFQxNDowMzoyMi40ODFaIiwiaSI6IuKApiJ9"
  }
}
```

Each `PublicAuditEntry` carries the actor (`actorType`, `actorId`), the tenant scope (`orgId`, `projectId`, `environmentId`), the subject (`kind`, `id`, `name`), and trace context (`requestId`, `correlationId`). Sensitive fields in `payload` are redacted server-side before the entry is returned.

## Iterate with the cursor

Walk pages until `meta.cursor` is `null`:

```bash
CURSOR=""
while :; do
  URL="https://api.orun.dev/v1/organizations/org_1f6a3c9e/audit?limit=100&category=membership"
  [ -n "$CURSOR" ] && URL="$URL&cursor=$CURSOR"

  PAGE=$(curl -s "$URL" -H "Authorization: Bearer $ORUN_CLOUD_TOKEN")
  echo "$PAGE" | jq -c '.data.auditEntries[]'

  CURSOR=$(echo "$PAGE" | jq -r '.meta.cursor // empty')
  [ -z "$CURSOR" ] && break
done
```

The SDK ships an async iterator that drives the same loop, with guards against cursor cycles:

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

for await (const entry of client.events.iterAuditEntries("org_1f6a3c9e", {
  by: "org",
  eventType: "member.role_changed",
  from: "2026-06-01T00:00:00.000Z",
  limit: 100,
})) {
  console.log(entry.occurredAt, entry.actorId, entry.eventType);
}
```

For one page plus its cursor (paginated UIs), use `client.events.listAuditEntriesPage(…)`; for an NDJSON export stream, `client.events.exportAuditEntriesNdjson(…)`.

## Related

- [Audit log](/platform/audit/audit-log)
- [Pagination](/api/pagination)
- [Rate limits](/api/rate-limits)
- [Members & invitations API](/api/resources/members-and-invitations)
