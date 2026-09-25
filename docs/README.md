# Agent Code docs

Layout and status conventions. Superseded/closed material moves to `archive/`
and carries a `Status:`/`ARCHIVED` header — a doc without one is meant to be
live.

## Live

- **[Application architecture](../ARCHITECTURE.md)** — arc42 reference with a large
  overview, C4 structure views, UML runtime diagrams, and implementation links.
  `architecture/diagrams/` contains its generated SVG previews.
- **`rendering/`** — the current rendering engine. `rendering-rewrite-plan-2026-07.md`
  is canonical; `residue-plan-2026-07.md` and `session-recording-plan-2026-07.md`
  are its live follow-ons; `legacy-deletion-manifest.md` is the cutover contract;
  `rendering-knowledge-dump.md` is the evidence bible. `research-2026-07/` holds
  the supporting research (rewrite research at the top level, the
  session-recording research under `session-recording/`).
- **`design/`** — living subsystem design (conditions, ghost system).
- **`plans_and_ideas/`** — active/near-term plans and idea notes.
- **`plans/`** — one plan per branch, `YYYY-MM-DD-<outcome>.md`, written with the
  [`writing-plans`](https://github.com/Juliusolsson05/agent-skills/tree/main/skills/writing-plans)
  skill. The plan is the branch's first commit and is kept true until merge
  (rulings, scope corrections, review dispositions). It carries a live `Status:`
  line during the PR; there is no post-merge freeze, because the PR and the
  project memory record what shipped.
- **`specs/`** — design specs, only for designs that need approval before a plan
  can be written. Otherwise the design lives in the plan.
- **`superpowers/`** — historical `plans/` and `specs/` written with the former
  superpowers plugin (retired 2026-09-24). Not written to anymore; kept in place
  so existing links resolve.
- **`decomposition/`** — stage decompositions written *before* implementation for
  risky work: several sources of truth, a stalled attempt, an unrecorded
  subsystem ([`staged-decomposition`](https://github.com/Juliusolsson05/agent-skills/tree/main/skills/staged-decomposition)).
  One file per subsystem, named for the subsystem rather than a date, because
  the document is revised in place when a stage disproves it — unlike plans,
  which belong to one branch.
- **`command-style.md`** — command-authoring conventions.
- **`screenshots/`** — README assets.

## Archived (`archive/`)

- **`codex-rewrite-render/`** — the pre-rewrite rendering notebook (superseded).
- **`issue-investigations/`** — investigations for issues now closed.
- **`audit-plans/`** — the deep-audit roadmap and its completed execution logs.
- **`release-readiness-2026-09.md`** — the ledger of the 2026-09-19 release-readiness goal loop that shipped 0.1.0 (#1106). Frozen; its still-open items were filed as issues.
