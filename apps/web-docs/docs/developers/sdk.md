---
title: TypeScript SDK
description: Typed, dependency-free, runtime-agnostic client for the Orun Cloud API — resource namespaces, per-request options, typed errors, and pagination.
---

The **Orun Cloud TypeScript SDK** (`@saas/sdk`) is a typed, contract-driven client
for the control-plane API. It has **zero runtime dependencies**, uses only Web
Platform primitives (`fetch`, `Headers`, `URL`, Web Crypto), and every request
and response type is generated from the same contracts the API workers validate
against — the console and the [`orun-cloud` CLI](/developers/cli) are both built
on it.

:::note
The SDK ships inside the [`sourceplane/orun-cloud`](https://github.com/sourceplane/orun-cloud)
repository as the private workspace package `@saas/sdk`; it is not yet published
to the public npm registry. Inside the monorepo (or a fork), add it as a
workspace dependency.
:::

## Install and instantiate

```jsonc
// package.json of a consumer
{
  "dependencies": {
    "@saas/sdk": "workspace:*"
  }
}
```

```ts
import { OrunCloud } from "@saas/sdk";

const client = new OrunCloud({
  baseUrl: "https://api.orun.dev",
  auth: { kind: "bearer", token: process.env["ORUN_CLOUD_TOKEN"]! },
});
```

`baseUrl` points at the edge API (trailing slashes are stripped). The `bearer`
token is any credential the API accepts — a workspace API key or a user session
token; see [Authentication](/api/authentication). Client options:

| Option | Type | Notes |
| --- | --- | --- |
| `baseUrl` | `string` | Required. Base URL of the edge API, e.g. `https://api.orun.dev`. |
| `auth` | `{ kind: "bearer", token }` \| `{ kind: "session", cookie }` | Optional; sent on every request when present. |
| `defaultHeaders` | `Record<string, string>` | Merged into every request; per-request headers win on conflict. |
| `fetch` | `typeof fetch` | Custom `fetch` implementation. Defaults to the platform global. |

## Runtime support

The same source runs unmodified on every runtime with a WHATWG `fetch` and Web
Crypto on the global — there are no `node:*` imports anywhere in the package.

| Runtime | Status |
| --- | --- |
| Node ≥ 20 | Tier 1 — native `fetch` / Web Crypto |
| Browsers (modern) | Tier 1 |
| Cloudflare Workers | Tier 1 — pure Web Platform |
| Bun | Tier 1 |

On platforms without a global `fetch`, inject one via `new OrunCloud({ fetch })` —
also the seam for tests and for wrapping requests with retries (see
[No built-in retries](#no-built-in-retries)).

## Resource namespaces

Every API surface is reachable as `client.<resource>`:

| Namespace | Covers |
| --- | --- |
| `workspaces` | Workspaces — the public vocabulary. Same ids and surface as `organizations`, served via the `/v1/workspaces` alias. |
| `organizations` | The canonical `/v1/organizations` spelling. Fully supported; new code should prefer `workspaces`. |
| `repos` | Projects, under the canonical name (a project is a git repo). Same surface as `projects`. |
| `projects` | Deprecated alias of `repos` — retained for one minor. `list`, `get`, `create`, `archive`. |
| `environments` | Environments under a project. |
| `memberships` | Members, invitations, role updates. |
| `teams` | Teams, team members, role grants, effective access. |
| `apiKeys` | Workspace API keys (create, list, revoke). |
| `webhooks` | Webhook endpoints, subscriptions, delivery attempts, secret rotation, replay. |
| `metering` | Usage recording, batch ingest, summaries, quota checks, quota violations. |
| `billing` | Plans, customer, invoices, entitlements, checkout, portal, plan changes. |
| `events` | The audit log — list, page, iterate, NDJSON export. |
| `securityEvents` | Actor-scoped account security events. |
| `config` | Settings, feature flags, secret metadata. |
| `notifications` | Email notifications and per-user preferences. |
| `auth` | Login, session, profile, OAuth provider discovery. |
| `cliSessions` | CLI device sessions and grant approval/denial. |
| `integrations` | GitHub integration: connections, repo links, deliveries, token minting. |
| `state` | State plane: workspace links, catalog, runs, content-addressed object reads. |
| `transport` | The underlying HTTP `Transport` — exposed for advanced extension. |

Contract types (`PublicProject`, `CreateOrganizationRequest`, `ERROR_CODES`, …)
are re-exported from `@saas/sdk`, so consumers never import `@saas/contracts`
directly.

## Per-request options

Every resource method accepts a final `RequestOptions` argument:

| Field | Type | Notes |
| --- | --- | --- |
| `idempotencyKey` | `string` | Sent as `Idempotency-Key`. Caller-owned — the SDK never auto-generates one. |
| `signal` | `AbortSignal` | Forwarded to the underlying `fetch` for cancellation/timeouts. |
| `requestId` | `string` | Sent as `x-request-id`. Auto-generated (`req_<uuid>`) when omitted. |
| `headers` | `Record<string, string>` | Per-request header overrides (last write wins). |

:::tip
Pass `idempotencyKey` on every create so a failed call can be retried with the
same key — the edge replay store guarantees no double-create within the 24-hour
replay window. See [Idempotency](/api/idempotency).
:::

## Typed errors

Every non-2xx response throws a subclass of `OrunCloudError`. Branch on the
class or on `error.code`:

| Class | `code` | Status |
| --- | --- | --- |
| `BadRequestError` | `bad_request` | 400 |
| `UnauthenticatedError` | `unauthenticated` | 401 |
| `ForbiddenError` | `forbidden` | 403 |
| `NotFoundError` | `not_found` | 404 |
| `UnsupportedError` | `unsupported` | 405 / 415 |
| `ConflictError` | `conflict` | 409 |
| `PreconditionFailedError` | `precondition_failed` | 412 |
| `ValidationError` | `validation_failed` | 422 |
| `RateLimitError` | `rate_limited` | 429 |
| `InternalError` | `internal_error` | 500+ |
| `OrunCloudError` (base) | _any_ | _any_ |

Every error carries `code`, `status`, `requestId`, `details`, the raw
`envelope`, and (when synthesized from a real response) the original `Response`
for raw header access. Two subclasses add structure:

- **`ValidationError.fields`** — field-level violations as
  `Record<string, string[]>`, decoded from `details.fields`.
- **`RateLimitError`** — `retryAfterSeconds` (from `Retry-After`, falling back
  to `details.retryAfterSeconds`), `scope` (`"org" | "identity"`), and
  `windows` decoded from the `X-RateLimit-{Limit,Remaining,Reset}-{org,identity}`
  headers, with `orgWindow` / `identityWindow` convenience accessors.

Unknown error codes (forward compatibility — e.g. a future `quota_exceeded`)
decode to the base `OrunCloudError` with the raw envelope preserved; non-JSON
5xx bodies (gateway HTML, empty body) decode to `InternalError` with
`message: "HTTP <status>"`. See [Errors](/api/errors) for the wire envelope.

## Pagination and iteration

List endpoints are cursor-paginated: the success envelope's `meta.cursor` is the
continuation token, and `null` means the end. The audit surface ships all three
consumption styles:

```ts
// One page + the cursor (for paginated UIs):
const { entries, cursor } = await client.events.listAuditEntriesPage("org_1", {
  by: "org",
  category: "billing",
  limit: 50,
});

// Every entry across every page, lazily:
for await (const entry of client.events.iterAuditEntries("org_1", { by: "org" })) {
  console.log(entry.eventType);
}

// NDJSON export — one JSON line per entry:
for await (const line of client.events.exportAuditEntriesNdjson("org_1", { by: "org" })) {
  process.stdout.write(line);
}
```

The iterator reads `meta.cursor` through the transport's envelope-aware path and
carries two loop guards: a hard cap of `AUDIT_ITERATOR_MAX_PAGES` (1000) page
reads, and a repeated-cursor check that throws rather than looping forever.
`securityEvents.listPage` and `webhooks.listDeliveryAttemptsPage` follow the
same page-plus-cursor pattern. See [Pagination](/api/pagination).

## No built-in retries

The SDK deliberately ships **no retry logic**: retries interact with
idempotency, rate-limit backoff, and abort semantics in ways the caller should
own. The transport seam is left clean so wrapping it is trivial:

```ts
import { OrunCloud, RateLimitError, InternalError } from "@saas/sdk";

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const retryable =
        err instanceof RateLimitError || err instanceof InternalError;
      if (!retryable || i >= attempts - 1) throw err;
      const delay =
        err instanceof RateLimitError && err.retryAfterSeconds !== null
          ? err.retryAfterSeconds * 1000
          : 2 ** i * 1000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// Safe because the same idempotency key replays, never re-executes:
const key = crypto.randomUUID();
const { project } = await withRetry(() =>
  client.repos.create("org_1", { name: "web-app" }, { idempotencyKey: key }),
);
```

Honor `RateLimitError.retryAfterSeconds` before retrying 429s — see
[Rate limits](/api/rate-limits).

## Worked examples

### List projects in a workspace

```ts
const { projects } = await client.repos.list("org_1");
for (const p of projects) {
  console.log(`${p.id}  ${p.name}  ${p.status}`);
}
```

### Create a project with an idempotency key

```ts
const { project } = await client.repos.create(
  "org_1",
  { name: "Web app" },
  { idempotencyKey: crypto.randomUUID() },
);
console.log(project.id);
```

If the call fails mid-flight, retry with the **same** key — the edge replay
store returns the original result instead of creating a duplicate.

### Handle validation failures field by field

```ts
import { ValidationError, RateLimitError } from "@saas/sdk";

try {
  await client.workspaces.create({ name: "" });
} catch (err) {
  if (err instanceof ValidationError) {
    for (const [field, problems] of Object.entries(err.fields)) {
      console.warn(`${field}: ${problems.join("; ")}`);
    }
  } else if (err instanceof RateLimitError) {
    console.warn(`back off ${err.retryAfterSeconds}s (scope=${err.scope})`);
  } else {
    throw err;
  }
}
```

### Cancel a slow request

```ts
const controller = new AbortController();
setTimeout(() => controller.abort(), 5_000);

const { organizations } = await client.workspaces.list({
  signal: controller.signal,
});
```

## Related

- [CLI (`orun-cloud`)](/developers/cli)
- [API overview](/api/overview)
- [Errors](/api/errors)
- [Idempotency](/api/idempotency)
