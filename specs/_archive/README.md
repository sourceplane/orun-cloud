# `_archive/` — Historical / superseded specs (NOT authoritative)

Files in this directory are preserved for provenance only. They are **NOT** the
authoritative spec and **MUST NOT** be cited in task prompts, design decisions, or
implementation reviews. The authoritative material is in `specs/core/`,
`specs/components/`, and `specs/epics/`.

A doc lands here only when it is **fully closed** (the program it describes is
complete) or **superseded** (replaced by a newer spec). A merely-*implemented*
spec does **not** belong here — shipped specs stay in place with their
`IMPLEMENTATION-STATUS.md`; see `specs/README.md` § Status legend.

## Contents

### `schedule.md`
The original "Recommended 8-Week Plan" that sequenced the bootstrap (Orun repo
skeleton → foundation → tenant core → operations → billing → product surfaces →
optional resources → hardening). The bootstrap is long complete (~130 tasks
merged), so the dated plan is historical. Its **evergreen** sections — the
Delegation Checklist, Merge Policy, and First Extraction Candidates — were lifted
into the live `specs/core/operating-model.md`; read that, not this, for current
delivery rules.
