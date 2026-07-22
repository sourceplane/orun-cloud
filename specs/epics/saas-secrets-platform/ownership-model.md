# Ownership model — surface by surface

> Who owns what, on every surface, once the inversion lands. The rule is one
> line; the rest is applying it consistently.

## The rule

> **The substrate owns the value. The integration owns the authoring.**
>
> Create flows *down* from the owner. Lifecycle flows *through* the substrate.

A secret is authored where its value comes from:

- **human value** → the Secrets surface (its native home).
- **provider-minted value** → the provider's own space.

Everything after creation — store, version, resolve, govern, rotate, reveal,
revoke — is the substrate's, uniformly, for every type.

## Surface 1 — the Secrets page (the substrate lens)

**Owns:** the unified view of *every* secret; type-generic lifecycle actions;
creation of **static** (human) secrets only.

**What changes (SP3):**

- The create dialog loses the "Scoped credential" and "Rotated" tabs. It creates
  **static** secrets only. (The RS4 "Rotated" tab moves to the Cloudflare space.)
- Integration-bound rows still appear, rendered by type (`brokered · …`,
  `rotated · … · every 30d`, orphan/health badges) — **view + manage stays**
  (SP-D1: keep + view). Their row action menu offers rotate / reveal / revoke /
  versions (type-generic) **and** a "Managed by {integration}" affordance that
  deep-links to the owning space for anything create-shaped (re-bind, template
  change).
- "New secret" on this page = a static secret. To create an integration secret,
  the empty-state and the type filter both point to the owning integration.

**Rationale:** one place to *see* and *operate* every secret is the substrate's
whole value; only *authoring* an integration secret is displaced, because only
authoring needs provider knowledge.

## Surface 2 — the integration page (the owner's space)

**Owns:** creating its own secrets; its scope-template catalog; its connections;
its provider-specific create UX.

**What it gains (SP2):** a **Secrets** section on the Cloudflare (then Supabase)
integration page:

- **Create** — the custom authoring surface (§custom plugin): pick the account/
  connection, pick or manage a scope template, choose brokered vs rotated,
  set the rotation policy + grace + deliver target. Calls the substrate's
  authoring interface; the substrate performs the governed write.
- **This provider's secrets** — the subset of secrets produced from this
  integration's connections (a filtered substrate read), so the owner sees its
  own footprint in its own space.
- **Scope templates** — the integration curates its template catalog here
  (SP4); it is the source of truth the substrate reads via the SP0 endpoint.

**What it does NOT own:** storage, encryption, the resolve path, the scope
chain/lock/policy — it calls the authoring interface for all of it.

## Surface 3 — the CLI (SP5)

The same boundary, expressed in command namespaces:

| Command | Owner | Purpose |
|---|---|---|
| `orun secrets set KEY` | substrate | create a **static** secret |
| `orun secrets list / versions / reveal / revoke` | substrate | view + type-generic lifecycle (all types) |
| `orun secrets rotate KEY [--remint]` | substrate | lifecycle (re-mint for provider-rotated) |
| `orun integrations cloudflare secret create …` | integration | author a Cloudflare-bound secret |
| `orun secrets set --from-broker …` | (deprecated) | → the namespaced form |

`orun secrets` reads/manages everything; *authoring* an integration secret moves
under the integration namespace, mirroring the UI.

## The ownership matrix (authoritative)

| Action | Static | Personal | Brokered | Provider-rotated |
|---|---|---|---|---|
| **Create** | Secrets | Secrets | **Integration** | **Integration** |
| View / list | Secrets (unified) | Secrets | Secrets | Secrets |
| Rotate | Secrets | Secrets | n/a (source-roll) | Secrets **or** Integration |
| Reveal (break-glass) | Secrets | Secrets | n/a (no stored value) | Secrets |
| Revoke | Secrets | Secrets | Secrets **or** Integration | Secrets **or** Integration |
| Versions | Secrets | Secrets | n/a | Secrets |
| Health / orphan | Secrets | — | Secrets | Secrets |
| Scope templates | — | — | **Integration** | **Integration** |
| Resolve / inject / materialize | substrate | substrate | substrate | substrate |

(SP-D2: lifecycle verbs are type-generic, so they may be surfaced in **both**
the Secrets lens and the integration space; **create** is the only
owner-exclusive verb.)

## Why the boundary sits exactly here

- **Create needs provider knowledge** (which connection, which template, which
  posture) — that knowledge lives with the integration, so create lives there.
- **Lifecycle does not** — rotate/reveal/revoke/version are secret verbs that
  operate on stored metadata + ciphertext the substrate already owns; they need
  no provider knowledge, so they stay uniform on the substrate.
- **Viewing is the substrate's reason to exist** — a single governed inventory
  of every secret, regardless of who authored it.

Put differently: the integration is the *producer* and the substrate is the
*custodian*. A producer decides what to make and how; a custodian holds, guards,
and services it the same way for everyone.

## Migration (no orphaned UX)

- SP2 lands the Cloudflare create space **before** SP3 removes the Secrets-page
  create tabs — never a window where you cannot create a Cloudflare secret.
- Existing brokered/rotated secrets are unaffected (same rows, same actions);
  only the *entry point for creating new ones* moves.
- The deep-link from the Secrets lens's "Managed by {integration}" affordance
  lands on the owner's create/manage surface, so discovery survives the move.
