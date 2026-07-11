---
title: The console
description: A tour of app.orun.dev — sign-in, the workspace overview, catalog, projects, activities, audit, usage, billing, and settings.
---

The **console** at [`https://app.orun.dev`](https://app.orun.dev) is the human surface of Orun Cloud. It speaks the same public API as the SDK and CLI, and its URLs are scope-driven: everything inside a workspace lives under `/orgs/{slug}/…`, where `{slug}` is your workspace's URL slug.

## Sign in and onboarding

`/login` signs you in with an email code — Orun Cloud is passwordless. On your first login, a mandatory full-screen onboarding (`/onboarding`) has you name your organization, pick a plan, and choose a starting point; there is no org-less view, so you always land in a working workspace. Create additional workspaces later at `/orgs/new`. See [Authentication](/platform/identity/authentication).

## Workspace overview

`/orgs/{slug}` is the workspace home — an at-a-glance overview of the workspace you're scoped to. The sidebar navigates to every area below.

## Catalog

`/orgs/{slug}/catalog` is the internal-developer-portal view of everything your platform intent declares: metric tiles, a filterable toolbar, and Table/Board/Map views over catalog entities, with a peek drawer and dedicated per-entity pages. Entities arrive from orun pushes — see the [state plane overview](/platform/state-plane/overview).

## Projects

`/orgs/{slug}/projects` lists the workspace's projects (a project == a repo): create projects, attach GitHub repos, and archive. Each project page has focused tabs:

- **Config** — project-scoped settings ([Settings and feature flags](/platform/configuration/settings-and-feature-flags)).
- **Git** — link GitHub repositories to the project ([GitHub integration](/platform/integrations/github)).
- **Storage** — the remote-state storage report, with a reclaim action for unreachable objects.
- **CLI** — the clones/workspaces linked to this repo via `orun auth login`, with unlink controls.
- **Environments** — create and inspect the project's environments ([Projects and environments](/platform/projects/projects-and-environments)).
- **Runs** — run detail pages, deep-linked from Activities (the per-project runs list redirects to the workspace-wide Activities feed).

## Activities

`/orgs/{slug}/activities` is the workspace-wide run feed, spanning every project and filterable by repo, environment, source, and status. Click a run to open its detail page. See the [state plane overview](/platform/state-plane/overview).

## Work

`/orgs/{slug}/work` is the work tracker: initiatives, epics with their milestone ladders, designs, boards, and a triage lane for agent-proposed changes. Every level drills down — portfolio → initiative → epic → milestone → task — and every lifecycle value you see is **derived** from the coordination and observation logs with its evidence attached; there is no status dropdown anywhere. See [Work](/platform/work/overview) and [the planning hierarchy](/platform/work/planning-hierarchy).

## Audit

`/orgs/{slug}/audit` shows the workspace's immutable audit log — who did what, when, to which subject — with the same filters the API exposes. Requires the `audit.read` permission. See [Audit log](/platform/audit/audit-log).

## Usage

`/orgs/{slug}/usage` charts metered consumption per metric key and window, shows what the workspace stores in remote state and recent push volume, and lists recorded quota breaches. See [Usage and quotas](/platform/metering/usage-and-quotas).

## Billing

`/orgs/{slug}/billing` (and **Settings → Billing**) shows your plan, subscription, and entitlements, with an embedded checkout to change plans. See [Plans and entitlements](/platform/billing/plans-and-entitlements) and [Checkout and portal](/platform/billing/checkout-and-portal).

## Members, invitations, API keys, integrations, webhooks

Each collaboration surface has its own page under the workspace:

- **Members** (`/members`) — list members and manage role assignments ([Members and invitations](/platform/workspaces/members-and-invitations)).
- **Invitations** (`/invitations`) — invite by email, track and revoke pending invitations.
- **API keys** (`/api-keys`) — create and revoke service-principal keys; the secret is shown once at creation ([API keys](/platform/identity/api-keys)).
- **Integrations** (`/integrations`) — connect GitHub for the workspace ([GitHub integration](/platform/integrations/github)).
- **Webhooks** (`/webhooks`) — endpoints, subscriptions, per-endpoint delivery history ([Webhooks overview](/platform/webhooks/overview)).

## Settings hub

`/orgs/{slug}/settings` is the workspace's administrative hub. The landing page shows the workspace's three identifiers — the durable **Workspace ID** (`ws_…`), the legacy id (`org_…`), and the mutable slug — each with a copy button (see [Vocabulary](/getting-started/vocabulary)). Its sections mirror the pages above and add:

- **Access** — your effective permissions in this workspace, with provenance ([RBAC](/platform/access-control/rbac)).
- **Teams** — create teams, manage membership, and grant roles at account, workspace, or project scope ([Teams](/platform/workspaces/teams)).
- **Config** — workspace settings and stable identifiers for API/SDK use ([Settings and feature flags](/platform/configuration/settings-and-feature-flags)).
- **Notifications** — your email notification preferences for this workspace ([Email notifications](/platform/notifications/email)).
- **CLI sessions** — the Orun CLI devices connected to your account, with revoke controls ([CLI and CI auth](/platform/identity/cli-and-ci-auth)).
- **Members / Invitations / API keys / Billing / Audit / Integrations / Webhooks** — settings-side twins of the pages above.

## CLI device approval

Two pages complete the `orun` CLI's login flows (see [CLI and CI auth](/platform/identity/cli-and-ci-auth)):

- `/cli/approve?grant=…` — the browser-loopback flow: `orun auth login` opens this page, and you approve or deny the single-use grant for "Orun CLI on `<host>`".
- `/cli/device` — the headless flow: `orun auth login --device` prints a short code; enter it here to authorize that device.

## Account and security

- `/account` — your profile (your identity across every workspace) and session controls, including sign-out.
- `/account/security` — your account security event history: sign-ins, session changes, and other security events as they happen. See the [security model](/security/security-model).

## Related

- [Quickstart](/getting-started/quickstart)
- [Vocabulary](/getting-started/vocabulary)
- [API overview](/api/overview)
- [RBAC](/platform/access-control/rbac)
