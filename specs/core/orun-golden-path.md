# Orun Golden Path

Status: Normative reference

## Intent

This is the short in-repo version of the broader Orun context pack. Agents
should read it before changing `intent.yaml`, any `component.yaml`, Stack
Tectonic compositions, CI, or Terraform infrastructure.

An Orun repo is a component-native desired-state repository. It is not a bag of
CI scripts. Authors declare intent and components; compositions define typed
execution contracts; Orun compiles those inputs into an explicit plan DAG.

## Mental Model

| Concept | Meaning | Agent rule |
| --- | --- | --- |
| `intent.yaml` | Repo control plane: environments, discovery, composition sources, defaults, policies, triggers | Start here before editing CI or environment behavior |
| `component.yaml` | Local declaration for one app, package, test, or infra unit | Treat it as an ownership boundary |
| `spec.type` | Stable component contract such as `terraform` or `turbo-package` | Match an existing composition unless the task updates the stack |
| Composition | Schema, jobs, profiles, and reusable runtime behavior for a type | Put shared execution behavior here, not in components |
| Execution profile | Context-specific behavior such as `plan-only`, `apply`, PR, verify, or release | Use profiles/profile rules instead of hidden shell branching |
| `dependsOn` | Explicit component ordering edge | Use it whenever ordering or required context matters |
| Plan DAG | Compiled truth: jobs, steps, profiles, env, dependencies, paths | Inspect this before saying what will run |

## Layer Boundaries

| Layer | Owns | Must not own |
| --- | --- | --- |
| Intent | environments, discovery roots, composition sources, defaults, policies, triggers | long shell scripts or provider-specific execution logic |
| Component | name, domain, path, subscriptions, parameters, labels, dependencies | copied job templates or per-env imperative branching |
| Composition | schemas, jobs, profiles, step ordering, runtime contract | app-specific desired state |
| CI workflow | checkout, install Orun, compile one plan, fan out `orun run` jobs | direct app, Terraform, Wrangler, Supabase, or AWS apply logic |

## Golden Path Repo Shape

Use the `aws-admin` repo as the strongest current reference for Orun-shaped
Terraform component structure, S3 backend shape, environment defaults, and
README/component style. The pinned Orun runtime is the single source of truth in
`kiox.yaml`; do not hard-code a version anywhere else:

- `kiox.yaml` pins the Orun provider image (`ghcr.io/sourceplane/orun:<version>`)
  and `kiox.lock` records the resolved digest. This is the authority — quote it,
  don't restate the version in prose.
- `.github/workflows/ci.yml` uses `sourceplane/orun-action@<action-version>` with
  `version:` matching the `kiox.yaml` pin.
- `intent.yaml` declares composition sources and type bindings centrally.
- Environments are `dev`, `stage`, and `prod`; `stage` promotes from `dev`,
  and `prod` promotes from `stage`.
- Environment defaults live under `parameterDefaults.terraform`.
- Terraform components use `spec.parameters`, not untyped ad hoc env files.
- Component docs sit next to the component and explain resources, parameters,
  outputs, dependencies, and local verification.

When bumping the runtime, update `kiox.yaml`/`kiox.lock` and the `ci.yml`
`version:` together in one PR; no other doc should pin a literal version. If
`aws-admin` pins a different Orun runtime, treat that as reference-repo drift:
follow `aws-admin` for structure and this repo's `kiox.yaml` pin for runtime.

## Component Manifest Rules

Every component manifest should answer:

- What is the stable component name?
- Which composition type validates and runs it?
- Which domain/group does it belong to?
- Which environments does it subscribe to?
- Which profile is selected by default, and which profile rules change it?
- Which typed parameters does the composition schema expect?
- Which components must run before it?

Prefer this shape for Terraform components:

```yaml
apiVersion: sourceplane.io/v1
kind: Component
metadata:
  name: example-component
  description: Short operational purpose
  labels:
    domain: infra
    security-boundary: repo
spec:
  type: terraform
  domain: infra
  parameters:
    orgName: sourceplane
    stackName: example-component
    terraformDir: terraform
    terraformVersion: "1.15.3"
  env:
    AWS_EC2_METADATA_DISABLED: "true"
  dependsOn:
    - component: tf-state
  subscribe:
    environments:
      - name: dev
        profile: plan-only
        profileRules:
          - profile: apply
            when:
              triggerRef: github-push-main
```

If the composition schema does not allow a required parameter, update the
schema and profile/job contract rather than smuggling data through a shell step.

## Safe Workflow

Before editing, identify:

- the active `intent.yaml`;
- discovery roots;
- affected component manifests;
- the component type and composition source;
- selected environments and profiles;
- dependency edges into and out of the component.

Then validate with the cheapest command that proves the change:

```bash
kiox -- orun compositions --intent intent.yaml --long
kiox -- orun validate --intent intent.yaml
kiox -- orun component --intent intent.yaml --long
kiox -- orun plan --intent intent.yaml --view dag
kiox -- orun plan --intent intent.yaml --output plan.json
kiox -- orun run --plan plan.json --dry-run --runner github-actions
```

Use `--changed` for PR scoping checks. Use a full plan when changing
environments, promotions, composition sources, or cross-component dependencies.

## Anti-Patterns

Do not:

- bypass Orun with standalone CI execution logic;
- hide environment-specific behavior inside shell scripts;
- copy job steps across component directories;
- add component parameters the schema does not allow;
- edit generated `.orun/**` plans or locks as source;
- rely on directory order, file order, or naming accidents for execution order;
- log secrets, Terraform state, generated passwords, or provider tokens.

## PR Explanation

Every Orun-facing PR should say:

- which layer changed: intent, component, composition, CI, or docs;
- which component types and profiles are affected;
- whether environments or dependency edges changed;
- which `kiox -- orun ...` commands ran;
- what changed in the rendered plan DAG, or why the DAG is unchanged.
