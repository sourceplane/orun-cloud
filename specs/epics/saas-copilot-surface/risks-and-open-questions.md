# saas-copilot-surface — Risks & Open Questions

## Risks

**R1 — AG-UI protocol drift.** The vocabulary is young; upstream renames or
semantics changes would land in `@ag-ui` client updates. *Containment:* the
contracts dialect pin (`v: 1`) + the CX6 CI check make drift a loud,
versioned adapter change; the bridge is the only module that speaks both
dialects, so the blast radius is one file per stream.

**R2 — CopilotKit runtime coupling creep.** Parts of CopilotKit's docs and
defaults assume its CopilotRuntime; convenience APIs may quietly expect it.
*Containment:* lock 1 + lock 8 — headless-only usage, all imports confined
to `components/copilot/`, and the CX3 "flag off = byte-identical native
thread" snapshot keeps the escape hatch honest. If headless friction exceeds
its value, assistant-ui or a thin custom fold over the same doors is a
drop-in because AG-UI is the contract (the epic's core hedge).

**R3 — Client-tool social engineering.** A model (or a poisoned context)
asks the UI to do something the viewer didn't intend. *Containment:* the
closed registry with the §3.2 review bar (prefill never submit, open never
approve), action chips rendering every client-tool execution visibly, and
zero credential-bearing verbs client-side. The approval card is generated
only from server events and its verbs are not in the registry.

**R4 — Double-transport complexity.** Run-door SSE for the active turn plus
native WS for resume/multi-viewer is two carriages on one thread.
*Containment:* they carry the same seq-keyed frames from the same DO — the
fold dedupes by cursor exactly as the WS/SSE fallback pair does today; CX1's
property test (no gap, no duplicate) pins it.

**R5 — Turn pause on client tools.** Pausing the tool round awaiting a
browser is a new latency class inside the loop. *Containment:* the 60 s
synthesized-timeout result guarantees liveness; client tools are UI-cheap by
registry construction; the pause holds no extra DO state beyond the pending
call id.

**R6 — Bundle and paint regressions.** Copilot engines are not small.
*Containment:* the 90 KB gz code-split budget is a CI gate from CX3, not a
hope; non-chat routes never load the layer.

**R7 — Managed-run fidelity.** DX7 transcripts may lack per-step granularity
the sealed stream has, making the shared lens uneven. *Containment:* the
lens renders what the stream carries and says so (the DX honest-degradation
idiom); the tier pill sets expectations, and the mapping table treats
missing lanes as absent, not faked.

## Open questions

**Q1 — Regenerate semantics.** Is "regenerate" a new turn quoting the prior
user message (cheap, honest history) or a true retry that supersedes the
prior assistant rows? v1 ships the former; revisit if users read the thread
as duplicated.

**Q2 — Watch-door fan-out limits.** How many passive SSE followers per
thread before the DO should shed to the DispatchIndex doorbell pattern?
Measure in CX6; the ceiling is likely generous (the fallback path exists
today) but unmeasured.

**Q3 — Client-tool registry growth.** The six v1 verbs are deliberately
timid. The pressure will be for `ui_submit_*` verbs; the §3.2 bar says no.
Does a "viewer confirms in a native dialog" middle tier (agent proposes,
browser asks, viewer clicks) earn its complexity in v2?

**Q4 — Voice + attachments.** CopilotKit ships input affordances (audio,
files) we deliberately ignore in v1. Attachments would need a custody story
(where does a file live, who reads it) before any UI appears — a separate
epic if wanted.

**Q5 — Embedding beyond the console.** The watch door makes a read-only
dispatch embed (docs site, Slack unfurl) nearly free. Out of scope here;
noted because the door's shape was chosen so this stays possible.
