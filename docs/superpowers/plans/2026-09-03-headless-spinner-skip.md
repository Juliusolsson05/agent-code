# Headless: skip derived screen work for spinner-only repaints

Fixes #765 (claude-code-headless half; codex-headless remains a follow-up).
Submodule PR: Juliusolsson05/claude-code-headless#52 (branch
`perf/spinner-only-snapshot-skip`, commit pinned by the gitlink in this
branch).

## Problem

`HeadlessTerminal` gated snapshots on exact equality of `plain`/`recent`,
which a spinner glyph or `(Ns · …)` elapsed timer defeats every 100 ms.
Every defeated gate ran two per-cell markdown walks in the package, and
`ClaudeCodeHeadless` then ran the composer parse, the attribute cell walk,
the trust/resume/permission/compaction regex detectors, the slash-picker
and AskUserQuestion live-grid walks, four `JSON.stringify` keys and
`extractAssistantInProgress`. With ~10 sessions thinking that is 60–100
snapshot pipelines/s ≈ 300–500 cell walks/s on the Electron main thread —
for chrome. #761 gates the *emit* in the app's session manager; this
removes the *work* at its source.

The headless buffer's `scrollback: 10000` also retained ~12 MB per live
session of rows that no consumer ever reads (widest read is
`snapshotRecent(200)`; the user's pane scrollback comes from the raw PTY
stream, not this buffer).

## Design

All substance lives in the submodule (see its PR for detail):

- `volatileScreenText.ts` normalizes the volatile chrome (spinner glyph,
  timers, token counters) into a chrome-blind comparison key, exported
  from the package index.
- A frame whose key equals the last EMITTED frame's is flagged
  `spinnerOnly`: still emitted (activity detection keys off the live
  spinner), markdown strings reused from the previous frame, and the
  consumer skips every derived walk whose inputs cannot have changed.
- `scrollback` 10000 → 2000.

The host change in this branch is the gitlink pin bump plus this plan;
`agent-code` consumes `spinnerOnly` through the package's existing
snapshot type (additive optional field, no host code change required).

## Verification

Submodule (claude-code-headless#52, all in the submodule worktree):

- `volatileScreenText.test.ts` + `HeadlessTerminal.spinnerOnly.test.ts`:
  11/11 — normalization matrix; gate flags and reuses markdown; a real
  change clears the flag; activity still detected on spinner-only frames.
- Full core project: 79/79.
- `npm run typecheck` clean.

Host:

- `npm run typecheck` against the pinned submodule revision.
- `npm run submodules:check` (pins the checkout to committed revisions).

## Not in scope

- The same treatment for `codex-headless` (#765 names it; separate
  submodule PR).
- Any change to the app-side emit gate (#761 already merged).
# 2026-09-04 review refinement

The reviewed candidate is fb390e6, which includes the content-safe repair and
merged package main. It supersedes the original broad normalization and parser
skip described below. Only recognized status-line markdown is reused; normal
content and multiline drafts stay meaningful, and composer attributes plus
picker/condition state are evaluated on every emitted frame. Twenty-six focused
tests and package CI passed on the repair before the tree-identical main merge.
Host CI validates this exact pin. Merge Claude #52 first; preserve this descendant
if Agent Code #788's package-main ancestry update is merged as well.
