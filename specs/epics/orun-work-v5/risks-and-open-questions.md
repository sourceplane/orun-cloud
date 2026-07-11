# orun-work v5 — risks and open questions

Status: Living register. Decisions locked in the README's status table are
restated here only when they carry a live trade-off worth re-checking.

## Decision ledger (locked, with the trade-off named)

| # | Decision | Trade-off accepted |
|---|---|---|
| V5-A | One Work home, three lenses; tasks peek, durable nouns page | Two clicks to a task's full conversation (peek → sheet) instead of one; accepted because the peek covers the 90% read ("where is it, who's on it, what's the evidence") at zero navigation cost, exactly Linear's bet |
| V5-B | The mock extraction (design.md) is normative; dark derives from tokens | The dark theme ships without its own pixel mock — it will need a taste pass against real screens rather than a reference image; accepted to keep one source of truth instead of two that drift |
| V5-C | Linear's feel, honest chips — truth captions and evidence hovers are part of the component contract (WV-2) | Permanent prop-surface cost on every rollup component, and 12px captions spend vertical space Linear would not; accepted because deleting the truth source from the pixel is exactly the lie the product exists to refuse |
| V5-D | Presentation-only: the epic stops rather than grow the API | If a screen truly needs a new read shape (e.g. a combined home summary), v5 ships slightly chattier queries first and files the endpoint against a WH revision; accepted to keep the surface/model seam clean and this epic unblockable |
| V5-E | Rung icons encode ladder position ordinally (½ ring, ¾ ring), derived only | The ring looks like "percent done" to a Linear-trained eye and is not; the ordinal encoding is documented in the icon tooltip and never animated task-internally. Accepted for instant cross-tool legibility |
| V5-F | Agents render at equal visual rank with humans (square-star avatars, live chips, `n humans · n agents`) | Screens read "busier" than a humans-only tracker; accepted because hiding agent labor would misreport who is doing the work — attribution is a truth-source question, not a styling one |
| V5-G | Board demoted to a Display layout of the Tasks lens | Board-first teams lose a dedicated nav destination; accepted because saved views (lens+filter+display) restore any board as a one-click view, and the home stays one surface |

## Open questions

- **Q-1 (home summary read).** The home renders three lenses from
  existing reads (portfolio, epic list, task list + cycle summary). If
  dogfood shows the lens switch exceeding its 100ms budget on cold cache,
  do we accept a spinner, prefetch all three on home mount, or file the
  combined summary endpoint against WH? Leaning prefetch; decide in WV2
  with measurements.
- **Q-2 (default lens).** Mock and spec default to Initiatives (the why
  first); Linear's daily gravity says Tasks. Last-lens memory may make
  this moot. Re-decide at WV6 from dogfood telemetry: if >80% of
  home landings immediately switch lens, flip the default.
- **Q-3 (triage visibility).** Triage leaves the tab row and lives behind
  the `need attention` stat + ⌘K. Is a two-item entry enough for the
  human-decision queue, or does attention need a persistent badge in the
  sidebar? Watch drift/mention response latency in dogfood; escalate to a
  sidebar badge if decisions age.
- **Q-4 (peek vs. task page).** v5 removes the notion of a task page in
  favor of the peek + conversation sheet. Deep links to tasks (from
  Slack/ES notifications) open the epic page with the peek pre-opened. If
  external linking shows the need for a standalone canonical task URL that
  renders without its epic context, revisit — cheaply, since the peek is
  already a routed state.
- **Q-5 (density at scale).** The mock shows 5 initiatives / 9 epics / 13
  tasks. The dogfood corpus is ~18 epics / 73 tasks; real workspaces will
  exceed it. List virtualization is budget-gated in WV6 — but grouped
  lists with sticky `GroupBand`s virtualize awkwardly. If budgets fail,
  prefer per-group pagination ("show all 41 Done") over virtualization.
- **Q-6 (mobile).** Northwind's responsive rules cover the shell; the
  peek and the 1140px multi-column rows do not degrade obviously. Out of
  scope for WV0–WV6; a follow-up leg (bottom-sheet peek, collapsed row
  grammar) should be filed if mobile usage of the Work plane materializes.
- **Q-7 (cycle report).** The Tasks lens links `Cycle report →`. v3's
  cycles section has the burn-up; the mock implies a fuller report page.
  WV6 aligns the existing cycles surface to the language but does not
  design a new report — if the link deserves more than the burn-up,
  that is a small follow-up epic with its own mock.

## Deferred register

- Dark-theme pixel mock (derive-by-token first; commission a mock only if
  the taste pass fails) — V5-B.
- Standalone task page — Q-4.
- Mobile Work grammar — Q-6.
- Cycle report page — Q-7.
- Sidebar attention badge — Q-3.
