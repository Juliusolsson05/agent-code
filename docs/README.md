# Agent Code docs

Layout and status conventions. Superseded/closed material moves to `archive/`
and carries a `Status:`/`ARCHIVED` header — a doc without one is meant to be
live.

## Live

- **`rendering/`** — the current rendering engine. `rendering-rewrite-plan-2026-07.md`
  is canonical; `residue-plan-2026-07.md` and `session-recording-plan-2026-07.md`
  are its live follow-ons; `legacy-deletion-manifest.md` is the cutover contract;
  `rendering-knowledge-dump.md` is the evidence bible. `research-2026-07/` holds
  the supporting research (rewrite research at the top level, the
  session-recording research under `session-recording/`).
- **`design/`** — living subsystem design (conditions, ghost system).
- **`plans_and_ideas/`** — active/near-term plans and idea notes.
- **`superpowers/`** — dated planning space: `plans/` (feature/fix plans) and
  `specs/` (design specs). Accumulates by date; a plan carries a `Status:` header
  once it ships or is superseded.
- **`command-style.md`** — command-authoring conventions.
- **`screenshots/`** — README assets.

## Archived (`archive/`)

- **`codex-rewrite-render/`** — the pre-rewrite rendering notebook (superseded).
- **`issue-investigations/`** — investigations for issues now closed.
- **`audit-plans/`** — the deep-audit roadmap and its completed execution logs.
