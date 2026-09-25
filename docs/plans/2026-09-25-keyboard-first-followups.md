# Keyboard-first follow-ups (after #1221)

Standard plan. The findings are known and countable (three Claude review reports plus the tests my merge broke), and each fix is small and local. There are no open product calls beyond the ones #1221 already lists as UNCONFIRMED.

## Outcome

- Main's test suite is green again.
- The regressions and gaps the Claude review round found in merged #1221 are fixed:
  - a pending approval in one pane no longer disables Enter-to-send everywhere;
  - pane prompts cannot deadlock or leak focus;
  - keyboard focus is visible on accent-filled controls;
  - the owner checklist matches the code.

## Evidence (verified, do not re-derive)

- Reports: `temp/review3-1221-{a,b,c}-report.md`, from Claude reviewers at `90d2af13`.
- Main at `13ae6085` fails 9 renderer tests. All of them are main's own new tests querying accessible names that #1221 renamed:
  - `CommandKeybindingsRow.capture` queries "Add" and "Press keys… (Esc)" (7 tests);
  - `ConversationsPicker` queries "everywhere" (2 tests).
  The code is correct in both cases; only the queries are stale. `firstRun` passes alone (a load timeout in the full run).
- A-F1: `ConditionOptionList` renders `role="listbox"`. `composerEnterRegistry.hasOpenKeyboardOwner()` treats ANY listbox in the document as a keyboard owner. The resume strip and the Codex approval strip are long-lived, so one pending approval disables the global Enter router and Submit Active Composer for every pane. Reviewer A's probe reproduced it.
- B-F1: the `pane-dialog` inert pass skips only the dialog's own nodes. Two prompts mounting in ONE commit, for example on a TileLeaf remount (the host container is state, so it is null on first render), mark each other inert, and neither can be answered.
- B-F2 / A-F2: the inert pass runs once per container. Pane children mounted later (the Retry row, Mouse Mode Send/Stop, QueueStrip, the workflow selector) stay live under the scrim. The always-mounted PaneToast status region is marked inert, which silences its live region.
- A-F3: the document Enter router never checks `isInPaneInteractionOwner(target)`. Enter with focus on a ConditionPromptShell root submits another pane's hovered draft.
- A-F4: Raise Cap at the ceiling unmounts the focused button with the phase unchanged. Focus falls to `<body>`, and the latched goal-loop gate then swallows Tab, Enter and Space.
- C-F1: the built-in `--theme-focus-ring` is the accent. Accent-filled focused controls (the filled Button, the active OptionCard, the selected SegmentedControl segment, GlobalToast, the SettingsBar ON toggles) show no visible ring. `Switch` already uses `ring-offset-1 ring-offset-surface`.

## Changes

1. **Tests on main**: point the stale queries at the #1221 names. Absence checks go through one helper, so they cannot drift and pass vacuously.
2. **Enter router (A-F1, A-F3)**: a listbox owns the keyboard only when it contains the focused element, or when it is a transient popup (the slash picker, palette lists). Inline condition option lists never count. The router also bails when the target is inside a pane interaction owner. Regression tests use reviewer A's probes.
3. **pane-dialog inert (B-F1, B-F2, A-F2)**: one recompute from DOM order. It skips every pane dialog and scrim and the feedback layer (the pane toast), inerts the older dialogs under the newest, and re-runs on `childList` changes through a MutationObserver. Tests: same-commit mount, a late-mounted child, and the toast staying live.
4. **Goal-loop strand (A-F4)**: when a latched overlay is mounted and focus is on `<body>`, Tab refocuses the overlay's first control.
5. **Focus ring on accent (C-F1)**: add `ring-offset-1 ring-offset-surface` (as `Switch` has) to the accent-filled focused states.
6. **Checklist and ledger truth (C-F2)**: correct the 8 contradicting owner-checklist lines in the #1221 plan.
7. **Sweep misses (C-F3…F8, B-F4)**:
   - `-soft` tokens or `Alert` for the raw-alpha danger and warning boxes;
   - casing survivors, and the Couldn't / Can't / directory survivors;
   - the AI Workspace active-file row recipe;
   - WHYs for the bespoke widths, or presets;
   - the Usage chip weight and the Conversations filter row sizes;
   - stale WHY comments (`dialog-actions` Cancel, `dialog` 92vw, TileLeaf refusal toast).
8. **Test gaps (A survivors, targeted)**: pane-dialog `holdsFocus` restore, the useKeybinds pane-owner bail, TileLeaf `blocked` wiring, and the goal-loop overlay target gate.

## Tests

Every behaviour fix gets a renderer test with real key or pointer events that fails on main (swap the file back to prove it), plus mutation checks of the guard it adds.

## Verification

- `npx tsc -b`.
- Focused suites while working, and the full renderer run once at the end.
- CI is the gate.
- Boundary: the app is never launched, so the focus-ring visibility (item 5) is reasoned from tokens and needs the owner's eye.

## Out of scope

K2-5 (persistent toasts), and the #1221 UNCONFIRMED product calls.
## Dispositions (Claude review round on #1221)

| Finding | Verdict | Disposition |
|---|---|---|
| main: 9 renderer tests fail (stale accessible names) | valid | fixed in `e092232c` |
| A-F1: an inline approval listbox disables Enter-to-send app-wide | valid, regression | fixed in `4915e869` |
| A-F3: Enter inside a pane prompt sends another pane's hovered draft | valid | fixed in `4915e869` |
| B-F1: two prompts mounting in one commit inert each other (deadlock) | valid | fixed in `73b7fae2` (one controller per pane) |
| A-F2 / B-F3: pane children mounted after the prompt stay live | valid | fixed in `73b7fae2` (MutationObserver) |
| B-F2: the pane toast is inert under a prompt, so it is silent | valid | fixed in `73b7fae2` (feedback layer exempt) |
| A-F4: Raise Cap at the ceiling strands focus in the latched overlay | valid | fixed in `efdceaf1` |
| C-F1: the focus ring is invisible on accent-filled controls | valid | fixed in `b9cb9f5d` |
| C-F2: 8 owner-checklist lines contradict the code | valid | fixed in `90898a6c` (code or checklist, whichever was wrong) |
| C-F4: casing, "Couldn't" and "directory" survivors | valid | fixed in `90898a6c`. Ruling: full-sentence titles (questions, "Grok is asking") are sentence case, and noun-phrase titles are Title Case. "Can't resume …" stays, because it is a refusal, not a failure |
| C-F3: 11 raw-alpha danger/warning boxes | valid | fixed in `e1333b81` |
| C-F5 / F6 / F8, B-F4: row recipe, bespoke widths, stale WHYs | valid | fixed in `c2c9e97a` |
| C-F7: the Usage chip is font-normal beside font-medium | overstated | declined: its WHY documents the mixed weights; only "N/A" changed |
| C-F7: Grok/OpenCode footers without chips | overstated | declined: already adjudicated in #1221 round 1 (C5). Those shells wire no Escape or dialog Enter, so chips would lie |
| A survivors #4, #33 | valid | pinned in `14af9673` |
| A survivors #13, #14, #20, #22, #37, #41, #44–45, #50, #51, #53; B partial battery | valid test gaps | follow-up: each needs a TileLeaf / useKeybinds / useListNavigation harness beyond this fix's scope |
| B: firstRun timeout under full-suite load | suspicion | passes alone, and #1221 only recased that test; not treated as fixed |
