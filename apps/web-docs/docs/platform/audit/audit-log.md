---
title: Audit log
description: An immutable, queryable record of every significant action in a workspace — built on a structured event envelope with actor, tenant, subject, and trace blocks.
---

Every significant action in Orun Cloud — a role change, a config write, a billing event, a GitHub push — is recorded as a structured **event** and projected into an **immutable audit log** you can query per workspace. The write path is append-only: events and their audit entries are inserted in the same transaction as the change they describe, and no API exists to update or delete them.

## The event envelope

Events share one envelope with four identity blocks — **actor** (who), **tenant** (where), **subject** (what), and **trace** (how it correlates):

```json
{
  "id": "0d3f7a1c-8b2e-4f5a-9c6d-1e2f3a4b5c6d",
  "type": "membership.updated",
  "version": 1,
  "source": "membership-worker",
  "occurredAt": "2026-07-01T14:22:31.004Z",
  "actor": {
    "type": "user",
    "id": "usr_2b3c4d5e6f7a",
    "sessionId": "ses_8f9e0d1c2b3a",
    "ip": "203.0.113.42"
  },
  "tenant": {
    "orgId": "org_1f2e3d4c5b6a",
    "projectId": null,
    "environmentId": null
  },
  "subject": {
    "kind": "member",
    "id": "mem_7c8d9e0f1a2b",
    "name": null
  },
  "trace": {
    "requestId": "req_a1b2c3d4e5f6",
    "correlationId": null,
    "causationId": null,
    "idempotencyKey": "promote-priya-1"
  },
  "payload": { "memberId": "mem_7c8d9e0f1a2b", "previousRoles": ["viewer"], "role": "builder" },
  "audit": { "redact": [] }
}
```

- `actor.type` is one of `user`, `service_principal`, `workflow`, or `system` — automated actions (stale-environment sweeps, webhook drains) are attributed to `system`, CI runs to `workflow`.
- `tenant` scopes the event to a workspace and, where applicable, a project and environment.
- `trace.requestId` links the event back to the API request that caused it (the same `requestId` you see in every response's `meta`).
- `audit.redact` lists payload paths to mask before the entry is served — redacted fields appear as `"[REDACTED]"` in query results.

## The audit projection

Each event that matters for compliance is projected into an **audit entry**: the envelope fields flattened for querying, plus a human-readable **`category`** (`membership`, `config`, `billing`, …) and **`description`** ("Created project \"Checkout Service\""). Entries are immutable — the projection is written once, atomically with the event, and served read-only with redaction applied.

## Query the audit log

```
GET /v1/organizations/{orgId}/audit
```

Requires the `audit.read` permission (held by workspace `owner` and `admin`). All filters combine with AND semantics and never change the ordering — entries come back newest-first with cursor pagination.

| Query parameter | Description |
|---|---|
| `category` | Audit category, e.g. `membership`, `config`, `billing`, `integrations` |
| `actorId` | The actor id recorded on the event |
| `actorType` | One of `user`, `service_principal`, `workflow`, `system` |
| `subjectKind` | Subject/resource kind, e.g. `project`, `member` |
| `subjectId` | Subject/resource id |
| `eventType` | Exact event type, e.g. `membership.updated` |
| `from` | Inclusive lower bound on `occurredAt` (ISO-8601 with milliseconds, `Z`) |
| `to` | Inclusive upper bound on `occurredAt` (same format) |
| `limit` | Page size, 1–100 (default 50) |
| `cursor` | Opaque continuation cursor from `meta.cursor` |

```bash
curl "https://api.orun.dev/v1/organizations/org_1f2e3d4c5b6a/audit?category=config&from=2026-06-01T00:00:00.000Z&limit=50" \
  -H "Authorization: Bearer $ORUN_CLOUD_TOKEN"
```

```json
{
  "data": {
    "auditEntries": [
      {
        "id": "6b1c9d2e-3f4a-5b6c-7d8e-9f0a1b2c3d4e",
        "eventId": "0d3f7a1c-8b2e-4f5a-9c6d-1e2f3a4b5c6d",
        "orgId": "org_1f2e3d4c5b6a",
        "projectId": "prj_5e6f7a8b9c0d",
        "environmentId": null,
        "actorType": "user",
        "actorId": "usr_2b3c4d5e6f7a",
        "eventType": "secrets.updated",
        "source": "config-worker",
        "category": "config",
        "description": "Secret metadata revoked: stripe.webhook_signing",
        "subject": { "kind": "secret", "id": "8a7b6c5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d", "name": null },
        "occurredAt": "2026-06-20T10:03:11.482Z",
        "requestId": "req_a1b2c3d4e5f6",
        "correlationId": null,
        "payload": { "operation": "revoke", "scope": "project", "key": "stripe.webhook_signing" }
      }
    ]
  },
  "meta": { "requestId": "req_f6e5d4c3b2a1", "cursor": "eyJ0IjoiMjAyNi0wNi0yMFQxMDowMzoxMS40ODJaIiwiaSI6ImF1ZF8uLi4ifQ==" }
}
```

## Iterate with the cursor

Pass `meta.cursor` back as `?cursor=` until it comes back `null`:

```bash
CURSOR=""
while : ; do
  RESP=$(curl -s "https://api.orun.dev/v1/organizations/org_1f2e3d4c5b6a/audit?limit=100${CURSOR:+&cursor=$CURSOR}" \
    -H "Authorization: Bearer $ORUN_CLOUD_TOKEN")
  echo "$RESP" | jq -r '.data.auditEntries[] | [.occurredAt, .eventType, .description] | @tsv'
  CURSOR=$(echo "$RESP" | jq -r '.meta.cursor // empty')
  [ -z "$CURSOR" ] && break
done
```

The SDK ships a purpose-built async iterator that walks every page for you (with loop guards against cursor cycles), plus a single-page variant and an NDJSON export:

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env.ORUN_CLOUD_TOKEN! },
});

// Walk every matching entry across all pages
for await (const entry of client.events.iterAuditEntries("org_1f2e3d4c5b6a", {
  by: "org",
  category: "membership",
  from: "2026-06-01T00:00:00.000Z",
})) {
  console.log(entry.occurredAt, entry.eventType, entry.description);
}

// Or fetch one page and manage the cursor yourself (paginated UIs)
const { entries, cursor } = await client.events.listAuditEntriesPage("org_1f2e3d4c5b6a", {
  by: "org",
  limit: 50,
});

// Or stream the whole filtered log as NDJSON
for await (const line of client.events.exportAuditEntriesNdjson("org_1f2e3d4c5b6a", { by: "org" })) {
  process.stdout.write(line);
}
```

The query object also supports `by: "target"` with `subjectKind` + `subjectId` to pull the history of one specific resource.

:::tip
The audit family has a higher rate-limit budget than most read surfaces — 120 requests per identity and 600 per workspace per 60 s — sized for export loops. See [Rate limits](/api/rate-limits).
:::

## What lands in audit

Every worker that mutates state appends to the same log. Representative categories:

| Category | Examples |
|---|---|
| `membership`, `invitation` | Members added/removed, role changes, invitations created/revoked |
| `projects` | `project.created`, `environment.created`, `environment.archived` (including system-actor stale-archival) |
| `config` | Setting/flag writes, secret create/rotate/revoke (values never appear — write-only by construction) |
| `billing` | Plan assignments and billing lifecycle events |
| `webhooks` | Endpoint changes and `webhook.delivery.*` lifecycle |
| `integrations` | GitHub App connect/setup, repo links, and normalized `scm.*` events (`scm.push`, `scm.pull_request.opened|updated|merged|closed`, `scm.repo.linked`, …) |
| `api_keys`, `security` | API key issuance/revocation, security-relevant events |
| `support` | Admin-plane support actions (`support.action_recorded`, `support.access_denied`) — staff access to your workspace is itself audited |
| `runs`, `objects`, `catalog`, `workspace_links` | State-plane activity |

## Immutability and retention

- **Append-only writes.** The storage layer exposes only inserts for events and audit entries; there is no update or delete path, in the API or internally.
- **Atomic with the change.** Audit entries are written in the same transaction as the mutation they record — a change cannot commit without its audit trail.
- **Redaction at read time.** Sensitive payload paths declared on the event are masked as `"[REDACTED]"` when entries are served; the raw values are never returned through the audit API.
- **System actions included.** Automated behavior (stale-environment sweeps, integration drains) is recorded with `actorType: "system"`, so the log is complete, not just user-initiated.

Entries are retained indefinitely at the storage layer today — there is no automatic purge. Use the NDJSON export to mirror the log into your own retention pipeline.

## Related

- [Access control (RBAC)](/platform/access-control/rbac)
- [Pagination](/api/pagination)
- [SDK](/developers/sdk)
- [API reference: Audit](/api/resources/audit)
