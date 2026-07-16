# Cross-ref: SC7 scaffolder vs. orun's `orun-scaffolding` epic

> A pointer for the SC7 owner. The orun repo has a Draft v2 epic
> (`orun:specs/orun-scaffolding/`) whose design **assumes this SaaS portal builds
> the scaffolding GUI form, fed by a composition's typed `contract.inputs`**. That
> assumption is not reflected in SC7's current design. This note flags the
> divergence so it can be resolved deliberately, not discovered late.

## The contradiction

**orun-scaffolding's thesis** is *single-artifact ownership* (explicitly the
anti-Backstage moat): one composition owns `create → build → deploy`; scaffolding
is a **pure render of that composition's `contract.inputs` + `scaffold` block**;
the generated `component.yaml` is **catalog-valid by construction** (passes both
parsers + resolves onto the source composition) before the command exits. It
defers the web form to *this* portal as a non-goal, stating the form is *"fed by
the same `contract.inputs` schema"*.

**SC7 as designed today** is the opposite shape — a **template registry**:
`listCatalogTemplates` + a zod-form over the *template's own params* +
`scaffold(templateId, params)` that opens a **PR into a git repo** via the
integrations broker (IG4); the new service becomes catalog-valid *later* through
the normal `orun catalog push`. This is the template-artifact-owned-separately
model that orun-scaffolding's thesis rejects. And `contract.inputs` appears
**nowhere** in orun-cloud (specs or code).

So the two epics are heading in opposite directions on the same feature, and the
integration seam orun-scaffolding leans on (composition `contract.inputs` → this
form) is not adopted here.

## Decision needed (one of)

1. **Converge on the composition contract (preferred if the "one artifact" moat
   is real).** Re-point SC7's form to render a composition's `contract.inputs` /
   `scaffold` block; the CLI `internal/scaffold` engine (orun) becomes the shared
   source of truth, and this form is a second front-end over it. Note this makes
   SC7 depend on unbuilt orun work: the typed `contract.inputs` + `scaffold` block
   were **deferred** in orun (`orun-service-catalog` SC7 landed only a thin
   Composition-as-Entity; see `orun:specs/orun-scaffolding/REVIEW.md` §B1).

2. **Keep the template-registry path and let orun drop the claim.** SC7 stays as
   designed; orun-scaffolding removes its "the portal builds the form from the same
   schema" non-goal and stands as a CLI-only scaffolder. Two separate create paths,
   stated plainly.

Either is fine — but it should be chosen with the orun epic owner. Full analysis:
`orun:specs/orun-scaffolding/REVIEW.md` (§B2).

## No SC7 scope change implied by this note

This is a cross-reference only. It does not move SC7 off its current sequencing
(detachable tail, gated on IG4 + premium entitlement per `risks-and-open-questions.md`).
It only asks that the orun↔SaaS scaffolding seam be reconciled before SC7 is
scheduled.
