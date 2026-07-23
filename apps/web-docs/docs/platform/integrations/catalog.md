---
title: Integration catalog
description: Every integration the platform coordinates — connect posture, capabilities, and entitlements — generated from the Integration Registry manifests.
---

<!-- GENERATED FILE — do not edit by hand. Rendered from the Integration
     Registry manifests (apps/integrations-worker/src/providers/manifests/);
     regenerate: REGENERATE_INTEGRATION_DOCS=1 pnpm --filter ./tests/integrations-worker test -- manifest-governance -->

Every integration is declared by one **Integration Manifest** and served through the registry read (`GET /v1/organizations/{orgId}/integrations/registry`). The hub, each integration's page, the Secrets surface, and the `orun` CLI all derive from the same descriptors — this catalog is generated from them.

| Integration | Category | Connect | Capabilities | Status |
|---|---|---|---|---|
| **GitHub** | Source control | app install | connect, inbound, scm | Available |
| **Slack** | Messaging | OAuth | connect, inbound, messaging | Available |
| **Cloudflare** | Infrastructure | OAuth · token paste | connect, credential-broker, secrets | Available |
| **Supabase** | Infrastructure | OAuth | connect, credential-broker, secrets | Available |
| **Anthropic** | AI providers | API key | connect | Available |
| **OpenAI** | AI providers | API key | connect | Available |
| **OpenRouter** | AI providers | API key | connect | Available |
| **Daytona** | Compute | API key | connect | Available |
| **AWS** | Infrastructure | token paste | connect, credential-broker, secrets | On the roadmap |
| **Discord** | Messaging | OAuth | connect, messaging | On the roadmap |

## GitHub

Install the GitHub App: repo links, scm.* events, scoped tokens.

- **Category**: Source control · **Status**: Available · **Manifest**: v1
- **Connect**: app install
- **Capabilities**: connect, inbound, scm
- **Entitlement**: `feature.integrations.github`

## Slack

Connect a workspace: channel delivery, /orun, actionable alerts.

- **Category**: Messaging · **Status**: Available · **Manifest**: v1
- **Connect**: OAuth
- **Capabilities**: connect, inbound, messaging
- **Entitlement**: `feature.integrations.slack`

## Cloudflare

Connect accounts; mint short-lived scoped tokens, never paste keys.

- **Category**: Infrastructure · **Status**: Available · **Manifest**: v1
- **Connect**: OAuth · token paste — multiple connections supported
- **Capabilities**: connect, credential-broker, secrets
- **Entitlement**: `feature.integrations.cloudflare`

### Cloudflare token paste recipe

Create an Account API token (recommended — owned by the account, not a person; a user token with account scope also works) with these permissions. Templates you skip can be left off:

- `Account API Tokens Write` — mint and revoke the short-lived child tokens
- `Workers Scripts Write` — Deploy Workers template
- `Workers KV Storage Write` — Deploy Workers template
- `Account Settings Read` — Deploy Workers, Deploy Pages, Account read templates
- `Pages Write` — Deploy Pages template
- `DNS Write` — Edit DNS template
- `Workers R2 Storage Write` — R2 data access template

## Supabase

Connect an org: short-lived Management API access per run.

- **Category**: Infrastructure · **Status**: Available · **Manifest**: v1
- **Connect**: OAuth
- **Capabilities**: connect, credential-broker, secrets
- **Entitlement**: `feature.integrations.supabase`

## Anthropic

Bring your Anthropic key: models for agent sessions and dispatch.

- **Category**: AI providers · **Status**: Available · **Manifest**: v1
- **Connect**: API key — multiple connections supported
- **Capabilities**: connect
- **Entitlement**: `feature.integrations.anthropic`

## OpenAI

Bring your OpenAI key: models for agent sessions and dispatch.

- **Category**: AI providers · **Status**: Available · **Manifest**: v1
- **Connect**: API key — multiple connections supported
- **Capabilities**: connect
- **Entitlement**: `feature.integrations.openai`

## OpenRouter

Bring your OpenRouter key: one credential, many models.

- **Category**: AI providers · **Status**: Available · **Manifest**: v1
- **Connect**: API key — multiple connections supported
- **Capabilities**: connect
- **Entitlement**: `feature.integrations.openrouter`

## Daytona

Bring your Daytona account: sandbox compute for agent sessions.

- **Category**: Compute · **Status**: Available · **Manifest**: v1
- **Connect**: API key — multiple connections supported
- **Capabilities**: connect
- **Entitlement**: `feature.integrations.daytona`

## AWS

Short-lived STS credentials per run — on the roadmap.

- **Category**: Infrastructure · **Status**: On the roadmap · **Manifest**: v2
- **Connect**: token paste — multiple connections supported
- **Capabilities**: connect, credential-broker, secrets
- **Entitlement**: `feature.integrations.aws`

## Discord

Channel delivery for Discord servers — on the roadmap.

- **Category**: Messaging · **Status**: On the roadmap · **Manifest**: v1
- **Connect**: OAuth
- **Capabilities**: connect, messaging
- **Entitlement**: `feature.integrations.discord`

