# Web Console

Status: Shipped — live on main (trust code over this doc). Owning work epic: see specs/epics/ + specs/roadmap.md.

Primary monorepo targets:

- `apps/web-console-next`
- optional shared UI helpers in `packages/ui`

Primary dependencies:

- `specs/core/contracts/api-guidelines.md`
- `specs/core/product-overview.md`
- optional `specs/core/contracts/component-manifest.schema.yaml`
- `specs/components/01-edge-api.md`
- `specs/components/04-organizations-membership.md`
- `specs/components/05-projects-environments.md`

Cloudflare primitives:

- Cloudflare Workers + Static Assets (Workers-hosted SPA/SSR)
- Workers Custom Domain attached via the `cloudflare-domain` infra component

## Intent

Provide the usable SaaS starter console for humans without creating a second, UI-only system contract. The first screen after auth should be the working app surface, not a marketing page.

## Scope

- sign-in and session flows
- organization and project switching
- organization settings, members, and invitations
- project and environment management
- account, API-key, and security settings
- config and secret metadata management
- audit and usage views
- billing summary views
- notification preferences
- webhook configuration and delivery status
- admin/support workflows where enabled
- optional component registry browsing
- optional resource creation and status views

## Out Of Scope

- a generic CMS
- direct calls to internal service bindings
- bypassing the public API

## Hard Contracts To Honor

- Public API rules in `specs/core/contracts/api-guidelines.md`
- Component manifest schema in `specs/core/contracts/component-manifest.schema.yaml`

## Required Capabilities

### UX Principles

- Generate or strongly assist input forms from component manifests where practical.
- Reflect optional resource `status.phase` and deployment history clearly when resource extensions are enabled.
- Keep organization, project, and environment scope visible at all times.

### Required Flows

- sign in
- create organization
- invite and remove members
- accept invitation
- create project
- create environment
- manage account, API keys, and security settings
- manage project config and secrets metadata
- inspect audit history
- review usage and quota state
- review billing summary, subscription state, and invoices
- configure webhooks and notification preferences
- optionally create resources from component definitions
- optionally view deployment status

## Agent Freedom

- The agent may choose React and its routing stack or another modern frontend stack that deploys well on Cloudflare. The current target is Next.js 15 (App Router) on Cloudflare Workers + Static Assets via `@opennextjs/cloudflare`; deviation requires a one-line rationale in the implementer report.
- The agent may build a small design system in `packages/ui`. Recommended baseline: shadcn/ui + Radix Primitives + Tailwind v4 with CSS-variable design tokens. The agent has full latitude on palette, type scale, motion, and component breadth.
- Generated forms may be fully automatic or manifest-assisted, but they must remain driven by the shared component contract and by `packages/contracts` types (Zod schemas derived from or matched against the typed surface).

## Design Direction (Normative)

The console is the buyer-facing artifact. It must look credible against the
Vercel / Linear / Stripe Dashboard bar before any product surface is declared
done.

Required design properties:

- **URL-driven scope.** The multi-tenant invariant (`org → project → environment`) is reflected in the URL: `/orgs/:orgSlug/projects/:projectSlug/environments/:envSlug/...`. `sessionStorage` for navigation state is forbidden. `localStorage` for auth-token persistence is acceptable.
- **Persistent scope switcher.** A top-left switcher renders `[Org] / [Project] / [Env]` and is visible on every authenticated page.
- **Cmd-K command palette.** Global palette covering at minimum: switch org, switch project, jump to each page, create invitation, create API key, logout. Registry pattern so new product areas can register actions.
- **Designed empty states.** Every list view ships a designed empty state with a primary CTA and a one-line explanation of what the resource is. No `"No X yet"` + emoji placeholders.
- **Skeleton loading states.** Every list and detail view has a designed skeleton state. No `"Loading..."` plain text spinners.
- **Designed `precondition_failed` upgrade UX.** When a create flow returns `412 precondition_failed` from the entitlement seam, the UI renders a designed upgrade prompt distinguishing the four reason codes (`disabled`, `not_configured`, `malformed_limit`, `limit_reached`). Usage vs limit shown when available. CTA + "talk to sales" fallback. RequestId behind a Details disclosure.
- **Dark mode by default**, with a working light-mode toggle. Theming via CSS variables; no hard-coded color literals in components. This is also the foundation for white-label theming.
- **Optimistic mutations where safe** (rename, archive, role change) with clean rollback on error.
- **Personal organization on first login.** A user lands in a working scope, not a chooser screen. (Implementation owner: identity-worker + membership-worker; this spec just states the UX invariant.)

Required design-system properties:

- Every UI primitive used in the console comes from `packages/ui` (or a documented in-app design-system directory).
- No bespoke per-page styling beyond layout composition.
- Tokens (color, spacing, radii, type, motion) live in a single source file and are CSS variables, not Tailwind config constants.
- Primitives required at minimum: Button, Input, Select, Dialog, Sheet, DropdownMenu, Tabs, Table, Toast, Skeleton, Badge, Card, Form primitives, EmptyState, CommandPalette wrapper.

## API Consumption

- The console must consume `apps/api-edge` only. No internal service bindings, no direct database access, no admin-only routes.
- Types come from `packages/contracts`. No forked or duplicated types.
- After `packages/sdk` lands (see `specs/roadmap.md` B4), the console consumes the generated SDK rather than a bespoke `api.ts`.

## Acceptance Criteria

- A non-CLI user can complete the baseline SaaS starter flow without hidden admin endpoints.
- The UI does not invent fields or workflows that are absent from the public API contracts.
- Optional resource configuration inputs come from manifest definitions, not hardcoded per-component forms where avoidable.

## Extraction Seam

The web console is a client of the platform, not part of the platform core. It must remain replaceable without changing domain contracts.

## Deployment Model

The web console is deployed as environment-specific Cloudflare Workers using
the Workers + Static Assets model (composition `cloudflare-workers-assets-turbo`):

- **Stage**: Worker `sourceplane-web-console-next-stage` (shadow hostname
  `https://sourceplane-web-console-next-stage.<workers-subdomain>.workers.dev/`)
  - Custom domain: `https://stage.sourceplane.ai/` (from `CONSOLE_CUSTOM_DOMAIN` env var)
- **Prod**: Worker `sourceplane-web-console-next-prod` (shadow hostname
  `https://sourceplane-web-console-next-prod.<workers-subdomain>.workers.dev/`)
  - Custom domain: `https://prod.sourceplane.ai/` (from `CONSOLE_CUSTOM_DOMAIN` env var)

Each deployed console is locked to a single API edge environment at build time
via the deploy-env variable. The stage console calls only the stage
`api-edge`; the prod console calls only the prod `api-edge`. Cross-environment
target switching is available only during local development and is stripped from
deployed builds.

Custom domains are managed by the `cloudflare-domain` infrastructure component
(`infra/terraform/cloudflare-domain`). The domain component depends on
`web-console-next` to ensure the Worker exists before attaching the Workers
Custom Domain (`cloudflare_workers_domain` in the Cloudflare TF provider v4).
The source of truth for hostname assignments is `intent.yaml` →
each environment's `env.CONSOLE_CUSTOM_DOMAIN` declaration. To change domains,
update the environment variable values in `intent.yaml` and re-deploy.

> Historical note: prior to task-0083 the console was hosted on Cloudflare
> Pages (`apps/web-console`, composition `cloudflare-pages-turbo`). That app
> was deleted and its custom domains were cut over to the Workers-hosted
> `apps/web-console-next`.
