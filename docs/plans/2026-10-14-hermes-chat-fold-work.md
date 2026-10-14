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

## Review round (one round, two reviewers)

### Fixed
- **A F1.** A heading inside a thought that is still streaming now sets the live line's headline. Before, the line kept the previous step's heading, or showed nothing.
- **A F2 / B1.** Pure tests on recorded S4 now cover:
  - row reuse when nothing changed;
  - a new row once the running tool finishes;
  - the headline while the model thinks after a tool.
- **B2.** Row order is now asserted (user → run → reply). A second test runs the S4 turn twice: two runs, each before its own answer.
- **B3.**
  - The `line-clamp-8` class is asserted.
  - A short prompt gets no button.
  - A `/skill` expansion never folds.
- **B4.** The fold button has `aria-expanded`.
- **B5.** The run's status is spoken as a word for screen readers ("Failed:" / "Running:").
- **B6.** The fold button uses `text-ink-dim`. The muted ink measured 2.4–3.6:1 on the prompt bubble.
- **B7.** A chevron marks the run line as something that opens. The pulse animation is now `motion-safe`.

Each guard was mutation-checked: removing reuse, removing the run boundary, gating the headline on finished thoughts, colouring a run red on any error, and letting an error outrank running. Each of these turns a test red.

### Commented, not changed
- **A F3.** An opened live run closes when its turn commits. The ledger's live key and committed key differ, and every chip already behaved this way before this PR.

### Ruling (UNCONFIRMED, owner call)
- **A F4.** A run shows ✕ only when its last tool failed. Earlier failures appear as "N failed" in the counts. **Why:** agents often probe, fail and retry, as recorded S4 does. **Cost if wrong:** a run that ended in a correct answer would still need its failure called out.
