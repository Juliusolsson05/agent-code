# OpenCode Terminal Read Commands Implementation Plan

> Status: IN PROGRESS on `feat/opencode-terminal-read-commands`. Closes #971.

**Goal:** Reader Mode, View Prompts, and Copy Last Response work on OpenCode
Terminal panes off the committed history PR #882 already loads — without
mounting a rendered feed on the pane or touching the TUI surface pin.

**Architecture:** One renderer predicate flip plus comment corrections. No
main-process change, no package change, no rendering-pipeline change. The data
plane (initial history + durable committed stream into `runtime.entries`) and
the pane-surface safety (`getEffectiveAgentSurface` terminal pin,
`commandAllowedByRenderedViewPolicy`) both already exist and are tested.

**Tech Stack:** TypeScript, Vitest 4 (`unit` and `renderer` projects).

---

## 1. What the investigation established (evidence, not inference)

- PR #882 (merged 2026-09-12, Stage 6) loads history for OpenCode Terminal
  panes into `runtime.entries`
  (`src/renderer/src/workspace/hook/actions/initialHistory.ts`: "the two
  reasons this used to be skipped no longer hold") and keeps them current via
  the durable committed stream. The Stage 6 renderer test proves reloaded
  entries equal the live ones.
- The only thing hiding the three read commands is
  `sessionHasTranscript` (`src/renderer/src/workspace/transcriptAvailability.ts`),
  which returns `false` for `kind: 'opencode', providerRuntime: 'terminal'`
  on the grounds that "the history loaders … skip it" — a claim PR #882 made
  false in the same release cycle. Consumers of the predicate, exhaustively:
  - `toggle-reader-mode` `when` (features/reader/commands/readerCommands.ts)
  - `view-prompts` `when` (features/workspace/commands/sessionCommands.ts)
  - `copy-last-assistant` `when` (features/workspace/commands/paneCommands.ts)
  - Reader navigation refusal (workspace/control/agents.ts)
  - `setReaderModeSession` guard (workspace/hook/actions/reader.ts)
- None of those three commands declares a `renderedViewPolicy`, so they already
  pass `commandAllowedByRenderedViewPolicy` (a `none` policy returns `true`
  before the terminal-runtime check). Feed-mounted commands — Rewind to
  Prompt, Clear/Send Composer, Copy Assistant, Copy Code Block — carry
  `opens-`/`leases-`/`requires-rendered-feed` policies and stay hidden; that
  is correct, not drift.
- ReaderView does not need a mounted pane feed: `useLedgerFeedItems` folds
  `runtime.entries` per-mount inside ReaderView itself, and
  `readerMessagesFromFeedItems` treats committed `entry` items as a
  first-class source. OpenCode Terminal has no semantic live channel, so
  Reader shows committed prose only — exactly what the projection supports.
- View Prompts extracts user prompts from `runtime.entries` keyed by provider
  kind (`'opencode'` — the terminal runtime shares the kind and its
  `promptHistoryExtraction: true`).
- Copy Last Response calls `extractLastAssistantText(runtime.entries, kind)`;
  the Stage 6 test already proves it returns the last committed answer
  ("second") from reloaded history.

## 2. Design decisions

### D1 — Flip the shared predicate, not five call sites

`sessionHasTranscript` drops the `providerRuntime !== 'terminal'` exclusion.
The predicate's meaning was "does this session carry rendered transcript
entries" and that is now true for OpenCode Terminal. Patching each consumer
with a local special case instead would leave the predicate lying to the next
caller — the exact failure mode #865 created the predicate to end.

### D2 — The pane-surface invariant is enforced elsewhere and stays

`getEffectiveAgentSurface` keeps pinning terminal-runtime panes to the TUI in
every view mode, and `commandAllowedByRenderedViewPolicy` keeps hiding every
feed-mounted command for them. Reader Mode is a full-screen overlay that
renders the ledger projection, not the pane leaf; View Prompts is a modal;
Copy Last Response is a clipboard read. None mounts anything on the pane. The
Stage 6 test's three assertions (entries continuity, surface pin, policy
commands hidden) must keep passing unchanged.

### D3 — Reader on OpenCode Terminal is committed-only and that is honest

No live semantic text exists for this runtime, so Reader pages committed
assistant prose; `live` pages and follow-the-bottom simply do not occur until
a turn commits. No special casing in Reader is needed or added.

### Out of scope (tracked separately)

- Rewind to Prompt on OpenCode Terminal (#896): needs TUI draft delivery and
  `replaceSession` orchestration-metadata handling (#879).
- Copy Assistant picker / Copy Code Block: need a mounted feed surface.
- Composer commands: the TUI owns its input box.

## 3. Tasks

1. Red: update `transcriptAvailability.test.ts` — `{ kind: 'opencode',
   providerRuntime: 'terminal' }` now expects `true`; plain `terminal` still
   `false`. Add command-level tests proving the three commands' `when` gates
   accept an OpenCode Terminal session, and a control test that Reader
   navigation accepts it.
2. Green: flip `sessionHasTranscript`; rewrite its comment with the #882 →
   #971 history and the D2 invariant.
3. Correct the stale comments that restate the old exclusion:
   readerCommands.ts, sessionCommands.ts (`view-prompts` guard),
   paneCommands.ts (`copy-last-assistant` guard), agents.ts Reader refusal,
   reader.ts `setReaderModeSession` guard, agentDisplayMode.ts
   (`getEffectiveAgentSurface` "not for display" sentence).
4. Append the #971 outcome note to the Stage 6 status in
   docs/decomposition/opencode-terminal-headless.md.
5. `npm run check`.

## 4. Verification

- New tests from task 1 pass; `transcriptAvailability`, `agentDisplayMode`,
  `opencodeTerminalHistory` suites pass unchanged (D2 assertions intact).
- `npm run check` green: contract checks, typecheck, unit + system + renderer
  suites, package verification.
