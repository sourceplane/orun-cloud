# saas-unified-onboarding — Design (platform side)

Status: Proposed. Companion to the CLI-side spec
`orun/specs/orun-cloud/unified-onboarding.md` (cluster **UO**). The wire
contract in `saas-orun-platform/state-api-contract.md` is normative; this epic
adds **no new contract surface** for the happy path — it confirms existing
endpoints are safe to drive automatically, fills the one gap (zero-org
materialization), and renames the user-facing noun **Project → Repo**.

---

## 1. Where we already are (code reality)

The platform is closer to the target than the product UX implies. Verified in
the codebase:

- **A link binds a remote to one org+project.** `state.workspace_links`
  (`packages/db/src/state/types.ts:391`) has
  `UNIQUE (org_id, remote_url) WHERE status='active'`; v2 added the reverse
  `UNIQUE (org_id, project_id) WHERE active` — the **bijection**: one repo ⇔ one
  project, per org.
- **Create-link auto-creates the project from the repo name.**
  `POST /v1/organizations/{orgId}/cli/links`
  (`apps/state-worker/src/handlers/links.ts`) accepts an optional `projectSlug`;
  when absent it calls `deriveSlugFromRemote(normalizedRemote)` — `owner/my-app`
  → slug `my-app` — and creates the project on demand under the actor's
  `project.create` grant. **Repo name == project name is already the default.**
- **Resolve is org-scoped and safe.** `GET /v1/cli/links/resolve?remoteUrl=…`
  (`handlers/links.ts`) returns `{candidates, links}` restricted to the actor's
  orgs (resource-hiding); it never leaks links from orgs the user can't see.
- **CLI auth already issues org-scoped sessions.** `POST /v1/auth/cli/token`
  returns `orgs[]` with `{id, slug, name, role}`
  (`packages/contracts/src/auth.ts`), so the CLI knows the candidate orgs the
  moment login completes — everything `link` needs is in hand.

**Implication:** "link right after login" needs **no new endpoint**. The CLI can
call resolve+create itself. This epic's platform work is (a) make that automatic
drive safe and complete, and (b) the vocabulary rename.

---

## 2. UO1 — Confirm link-on-login is safe to automate

The CLI will call `resolve` then (on zero existing links) `create` immediately
after authentication, and again lazily on first `orun run`. Platform guarantees
to lock down:

1. **Idempotency.** A second `POST …/cli/links` for the same `(org, remote)`
   must return the existing active link (200/201 with the same `projectId`), not
   a 409 that the CLI has to special-case. Confirm the upsert path in
   `createWorkspaceLink` (`packages/db/src/state/repository.ts`) returns the
   existing row on the active-unique conflict; add a contract test.
2. **Repo-named project, deterministically.** `deriveSlugFromRemote` must be the
   single normalization authority and must agree with the remote normalization
   used for the unique index, so `https://github.com/Acme/My-App.git`,
   `git@github.com:Acme/My-App.git`, and `…/My-App` all map to one project.
   Add a table-test over remote variants.
3. **Policy unchanged.** Auto-link still runs under the actor's `org.cli.link` /
   `project.create` grants and deny-by-default. Automation is a CLI convenience,
   **not** a privilege escalation: a member who can't create projects gets the
   same 404 they get today, surfaced by the CLI as "ask an org admin to connect
   this repo, or pass `--org <where-you-can>`".

No schema change. Deliverable: contract + integration tests proving
resolve→create is idempotent and repo-named across remote forms.

---

## 3. UO2 — Zero-org actors get a home (the only real gap)

One-step onboarding breaks for a brand-new user who belongs to **no org**: there
is nothing to auto-pick and nothing to create a project under. The v2 direction
already names the fix (`saas-orun-backend-merge/risks-and-open-questions.md`
D3 / OV2): *a runner with only OIDC and no prior link auto-materializes a
per-owner default org + `project == repo`.* This epic brings the same
materialization to the **interactive login** path.

Design:

- On `orun login`, if the session's `orgs[]` is empty, the CLI calls a
  **materialize-default-org** step. Two options:
  - **(a) Reuse create-org** (`POST /v1/organizations`, `membership-worker` /
    `projects-worker` per `components/04`): the CLI creates a personal org named
    from the user (e.g. `rahul` / GitHub login), then links. No new endpoint;
    just sequence it.
  - **(b) Server-side materialize on first link** (recommended): teach
    `POST …/cli/links` to accept an org sentinel (e.g. `orgId=_default`) that
    materializes-or-fetches the actor's personal org, mirroring the OIDC path,
    so the CLI does one call. Keeps the "first reference materializes the node"
    rule (design-v2) consistent across CI and interactive.
- Personal-org naming, quota (one personal org per user), and upgrade-to-named
  follow `components/04-organizations-membership.md`; spell out the rule there.

Recommendation: **(b)** — one idempotent call, identical mental model to CI,
no client-orchestrated multi-step that can half-fail.

---

## 4. UO3–UO4 — Vocabulary: "Project" → "Repo"

The model says project == repo; the surface should too. Rename is **phased** to
avoid breaking the frozen contract and existing URLs.

### Phase A — labels only (no breaking changes)
- **web-console-next**: nav, command palette, headings, empty states. Concrete
  touch points found:
  - `components/shell/command-registry.ts` — `navItem("nav.projects", "Projects", …)`
    and `navItem("create.project", "Create project", …)` → "Repos" / "Connect a
    repo".
  - `components/shell/sidebar.tsx`, `sidebar-org-switcher.tsx`,
    `scope-switcher.tsx` — visible "Projects" labels (keep `projectSlug` params).
  - `app/(app)/orgs/[orgSlug]/projects/page.tsx` and `…/[projectSlug]/…` —
    page copy → "Repos" / a single repo.
- **Component specs**: reframe `components/05-projects-environments.md` to lead
  with "a project is a repo" and use "repo" in prose; keep the `projects.*`
  table and `projectId` field names with a one-line "named *repo* in the UI".
- **CLI-facing copy** returned in API messages (e.g. link/policy errors) shifts
  to "repo".

### Phase B — route + SDK aliases (additive)
- Add `/orgs/[orgSlug]/repos/[repoSlug]` as the canonical console route; keep
  `/projects/[projectSlug]` as a 308-redirect alias for bookmarks/links.
- `packages/sdk` / `packages/contracts`: expose `repos` accessors aliasing
  `projects` (deprecate `projects` in docs, keep for one minor).

### Phase C — internal rename (optional, later, gated)
- Renaming the DB schema (`projects.projects` → `repos.repos`), the
  `/v1/organizations/{org}/projects/{proj}/…` path segment, and `prj_` ID prefix
  is a **large, contract-breaking** change with little user value once labels and
  routes read "repo". **Deferred** unless a contract major (v2 path) is already
  being cut; if so, fold it in there. Default: **do not do Phase C** standalone.

Invariant for A/B: `prj_…` IDs, `projectId` JSON fields, and the
`/projects/` state path **do not change** — the wire contract stays frozen.

---

## 5. What does *not* change

- The state-plane routes `/v1/organizations/{org}/projects/{proj}/state/*` and
  their authz (`apps/state-worker/src/authz.ts`, deny-by-default → 404).
- CLI auth endpoints (`/v1/auth/cli/*`) and session/refresh rotation.
- The `{candidates, links}` resolve shape and the `WorkspaceLink` JSON.
- The OSS single-tenant `_local/_local` behavior ("one contract, two servers").

---

## 6. Milestones (cluster **UO**)

| ID | Deliverable | Done when |
|---|---|---|
| **UO1** | Link-on-login safe to automate | resolve→create proven idempotent + repo-named across remote forms; contract tests green; policy/deny behavior asserted unchanged. |
| **UO2** | Zero-org materialization | a no-org user's first `orun login` lands a working personal `org/repo` via one idempotent call; rule documented in `components/04`. |
| **UO3** | Console vocabulary (Phase A) | no user-visible "Project" string remains in `web-console-next` nav/pages/palette; `projectSlug` params untouched. |
| **UO4** | Spec + contract vocabulary | `components/05` + `13` reframed "repo"; API error copy says "repo"; IDs/paths unchanged. |
| **UO5** | Route + SDK aliases (Phase B) | `/repos/…` canonical with `/projects/…` 308 alias; SDK `repos` alias shipped + deprecation note. |
| **UO6** | (Optional) internal rename (Phase C) | only if folded into a contract major; otherwise explicitly **not scheduled**. |

UO1–UO2 unblock the CLI's one-step flow; UO3–UO5 complete the rename without
touching the contract.

---

## 7. Risks & open questions

1. **Personal-org sprawl.** Auto-materializing an org per new user can create
   junk orgs. Mitigate: one personal org per user, idempotent, clearly labeled,
   easy upgrade/merge into a named org. (UO2; `components/04`.)
2. **Auto-link under shared CI identity.** Auto-link must never bind a repo to an
   org the actor hasn't proven membership in — rely on existing deny-by-default;
   automation changes *who calls*, never *what's allowed*.
3. **Rename Phase C scope.** Confirmed **out of scope** unless a contract major
   is independently planned; Phases A/B deliver the product value at zero
   contract risk.
4. **`_default` org sentinel naming.** If UO2 option (b) is chosen, pick a
   sentinel that can't collide with a real `orgId` (slugs are validated; `_`
   prefix is reserved like `_local`).
