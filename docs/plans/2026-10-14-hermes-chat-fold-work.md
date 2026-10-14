# Fold runs of work and long prompts in the Hermes chat (#1508)

Size: short plan. The shape is known: it is a view-only change inside `features/hermes-chat`, and the ledger and ownership are untouched.

## Evidence (verified, do not re-derive)

- The owner's debug bundle `2026-10-14T16-26-49` has a pane snapshot with 425 rows: 21 user, 61 assistant, 136 reasoning and 206 tool rows.
- Tool names in that snapshot:
  - `terminal`: 109
  - `web_search`: 23
  - `tool_call`: 15
  - `memory`: 14
  - other tools: the remaining 45
- So the noise is the number of rows, not unclear names. An earlier idea, "show the inner tool of `tool_call`", was dropped: it covers only 15 of 206 rows.
- One prompt in that snapshot is a pasted multi-section guide that is taller than the screen.
- I checked all of this in a local browser preview: the real feed and real styles, fed the snapshot rebuilt as Hermes rows (git-ignored `temp/hermes-ui-preview`). Folding takes the conversation from 425 rows to 143.

## Change

- **`chatProjection.ts`**
  - `groupActivity(chat, previous)` folds each maximal run of `reasoning` and `tool` items into `{ kind: 'activity', key: 'activity:<first step key>', steps }`. It reuses the previous row object when its steps are identical, so memo still skips it.
  - `summarizeActivity(steps)` returns `{ status, tools: 'name ×n, …', headline, thoughts, progress }`. The headline is the running tool while the run is live, and the agent's latest reasoning heading once it is done. `progress` is the latest progress prose.
- **`HermesChatFeed.tsx`**
  - `ActivityRow` is a borderless `LazyDetails` holding a `ToolLine` and a `ReasoningRow` for each step. The latest progress note stays visible below it.
  - `UserBubble` folds prompts over 8 lines or 700 characters (`line-clamp-8`) behind a Show more / Show less button.
  - The pill `ToolChip` is gone, so its closed and open radius rule from #1506 no longer applies.

## Tests (recorded S4 through the real mapper and ledger)

Each test fails on the pre-change code; this was checked by reverting the source.

1. A run of work is one `activity` row whose summary names `terminal`, and no step rows are mounted.
2. Neither the run body nor a tool body is mounted until it is opened.
3. A long prompt folds and opens on click. Fixture: S4 with its prompt replaced by a 30-line paste, a mechanical mutation of the recording.

## Verification boundary

The app was not launched (standing rule). The look was judged in the browser preview, which renders the real components and stylesheet. Live streaming of a run was not exercised against a real server.

## Out of scope

Codex and Claude tool rows in the coding feed. Measured findings go to a follow-up PR.
