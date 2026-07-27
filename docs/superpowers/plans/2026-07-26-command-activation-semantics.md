# Command activation semantics

**Status:** planned, 2026-07-26
**Origin:** user reported that ⌥P (Prompt Template…) does nothing. Six classification
agents then swept all 99 catalog commands and the surface/store wiring.

---

## The one-sentence rule this establishes

> Invoking a command that shows a surface makes that surface visible; invoking it
> again dismisses it. That must be true from **every** invocation source, not just
> from inside the palette.

Nothing in the app enforces this today. Three independent layers break it, and no
single-layer fix is sufficient — a toggle written in a command body is unreachable
if the router refuses the second keypress, and a router fix is pointless if the
command has no way to ask "am I already open?".

---

## Layer 1 — the interaction-ownership gate makes dialogs un-dismissable by chord

`useKeybinds.ts:333` returns out of the entire key handler when
`hasAppInteractionOwner()` is true. That marker is stamped by **every** Radix
`DialogContent` (`components/ui/dialog.tsx:57`). The binding router lives at
`useKeybinds.ts:579`, well after the bail.

Consequence: **any surface built as a Dialog makes its own chord unreachable while
it is open.** The command's `run` is never called. This is not an admission
refusal — nothing in `when`, `resolveCommandAvailability` or the gateway is
involved, and no change confined to a `commands/*.ts` file can fix it.

This is why the user's chords split the way they do:

| Round-trips today | Dead second press |
|---|---|
| ⌥R Reader, ⌥S Spotlight (`MainSurface` inline) | ⌘⇧U Usage (Dialog) |
| Agent Status (plain `<aside>`) | ⌘⇧P Palette (Dialog, and `KeyP` is in `BLOCKED_META_CODES`) |
| `tiled-tabs` (asymmetric but complete) | Remote Panel (Dialog despite being registered as a side panel) |

`toggle-remote-panel` is the clean illustration: its store action is *already* a
correct toggle and its `getState` would work — it fails purely because
`RemotePanel.tsx:127` renders a `Dialog` where its sibling `AgentStatusPanel`
renders an `<aside>`.

**Fix:** resolve `routedCommandForEvent` BEFORE the ownership bail, and let the
chord through when the resolved command is the one that owns the currently-open
surface. Anything less leaves every toggle we write unreachable.

Do NOT "fix" this by making surfaces stop being dialogs. Modality is a real
property — Usage and the palette genuinely should trap focus. `RemotePanel` is a
separate, legitimate cleanup, but it is not the mechanism.

---

## Layer 2 — nine commands are silent no-ops from chord and native menu

The `enterXMode` family sets React `useState` on the palette component:

```
resume-session (⌘⇧R)   prompt-template (⌥P)   manage-prompt-templates
revive-pane            kill-buried-pane       save-composer-as-prompt-template
open-ai-workspace      create-ai-workspace    clear-ai-workspace
```

Two of these ship default chords and are dead from the keyboard TODAY:
`resume-session` (⌘⇧R, `defaults.ts:88`) and `prompt-template` (⌥P,
`defaults.ts:225`).

`resume-session` is a REGRESSION introduced by the governance PR: the old router
had a hard-coded ⌘⇧R branch that opened the resume picker directly, and routing
the chord through the command dropped the behavior on the floor.

### Two independent kill mechanisms — this is why the obvious fix is not enough

A chord sets `pendingCommandInvocation`, which mounts the palette host
**invisibly** (`visible={false}`, `CommandPalette.tsx:206-209`).

1. **Unmount.** The layout effect at `:967-989` dispatches, then synchronously
   calls `onMenuCommandHandled()` (clears the pending invocation) and `onClose()`.
   Next render the outer gate returns `null` and every `useState` — including
   `mode` — is destroyed.

2. **Mount reset.** Even if the host stayed mounted, the `deps: []` effect at
   `:884-905` calls `setMode('commands')`. Passive effects run AFTER layout
   effects in the same commit, so `'commands'` is queued last and wins over the
   `'resume'` queued inside the layout effect. StrictMode double-invokes it.

`keepPaletteOpen: true` does not help and never has on this path: it is read only
by the palette's OWN `executeCommand` (`:942-947`). The chord path goes through
`dispatchCommand`, which has no `keepPaletteOpen` branch at all. Nine commands
have been declaring a flag that does nothing outside the palette.

**Fix — move the mode into the store.** Add `paletteMode` to `uiShell` with a
`setPaletteMode(mode)` action that also sets `commandPaletteOpen: true`. Then
`ui.enterXMode` is an ordinary store write, immune to both mechanisms, and the
reset moves from mount-time to close-time.

The tempting three-edit patch — open the palette in `run`, extend the
self-excluded id set, skip the reset when an invocation was pending — was
considered and REJECTED. Omitting any one of its three parts leaves the bug, and
its correctness rests entirely on React effect ordering. The store-backed version
has no ordering argument to get wrong.

Moving the mode also fixes a latent problem: `enterResumeMode` and
`enterAiWorkspaceOpenMode` kick off async loads that currently re-run on every
mount.

---

## Layer 3 — commands cannot see their own surface

25 surfaces have a visibility flag in the store that is NOT on
`CommandContext.flags`, so the command cannot ask "am I already open?".
Separately, almost every `close*` action exists in the store but is not exposed
on `ctx.ui` — today only `closePalette` and `closeAgentStatusPanel` are reachable.

Nine of the 25 store a `SessionId | null` rather than a boolean
(`viewPromptsSessionId`, `rewindPromptSessionId`,
`agentViewModePickerSessionId`, `colorFlagPickerSessionId`, …). **A boolean
toggle is WRONG for these**: pressing ⌥⇧P while View Prompts is open for a
different session should re-target, not close. Expose the id, not just a
predicate.

One is genuinely derived and must not become a single field: the placement
overlay's visibility is
`newAgentPlacementOpen || dispatchAttachIntent !== null || linkedAgentParentId !== null`
(`usePlacementOverlay.ts:30`), and closing it means calling all three actions.

Mechanically each flag is THREE edits — the `flags` type, the context object
literal, and the memo dependency array. **Missing the third is a silent staleness
bug**: the flag is read once and never updates.

### Commands that must NOT become toggles

Verified individually; blanket-toggling would have broken all of these.

- `save-debug-logs`, `attach-recording-note` — each WRITES something (a bundle, a
  marker) before its prompt opens. A second press legitimately writes a second one.
- `open-settings` — a destination page, not a peek. (Its real bug is that Escape
  does not dismiss it: `useKeybinds.ts:537-541` is dead code behind the ownership
  gate, and the only exit is the Close button.)
- `open-command-palette` — a blind toggle makes double-taps flicker. The useful
  behavior is: in a sub-mode, return to command mode and clear the query; close
  only when already clean.
- `linked-agent`, `attach-detached-to-grid`, `bury-pane` — per-target modals with
  no toggle meaning.

---

## Discrete bugs found during the sweep

Independent of the three layers. Each is small and each is real.

1. **⌘⌥E Editor Fullscreen is a silent no-op when the editor is closed.**
   `when: flags.globalEditorOpen` runs in admission before `run`, making the
   branch that opens the editor straight into fullscreen unreachable from all
   four invocation sources. The branch is the intended behavior — an orphaned
   comment on `save-editor-file`'s `when` describes exactly it ("the chord has
   always meant 'give me a big editor' as ONE gesture… or routing would silently
   drop half the feature"). Routing did. Delete the `when`, keep the branch, move
   the comment. **Regression from the governance PR.**

2. **File → Save with the editor closed is admitted and does nothing.**
   `save-editor-file`'s `when` admits on `globalEditorOpen || focusedCwd`, but its
   window event has no listener until `EditorWorkbench` mounts. Tighten to
   `flags.globalEditorOpen`.

3. **Four commands re-implement open-if-closed against a snapshotted flag.**
   `ui.toggleGlobalEditor` is the only editor primitive on the bridge, so
   `quick-open-file`, `search-in-files`, `toggle-editor-fullscreen` and
   `CommandPalette.tsx:1113` each do read-then-toggle. A stale `true` CLOSES the
   editor the user asked to open. `openGlobalEditor`/`closeGlobalEditor` already
   exist on the store; expose them.

4. **`revive-pane` / `kill-buried-pane` admission disagrees with their list.**
   `when` checks `state.buried.length > 0` while the list is filtered to the
   active tab, so both can be admitted onto an empty mode.

5. **Eight dead members on `CommandContext.ui`** — `openResumePicker`,
   `openAgentStatusPanel`, `closeAgentStatusPanel`, `toggleStatusMode`,
   `toggleWorktreeBadges`, `toggleUsageHeader`, `cycleUsageHeaderLevel`,
   `setDangerousAgentsEnabled`. Note `openResumePicker` is the ready-made
   store-backed path for `resume-session` if we prefer it to the palette mode.

6. **`toggleCommandPalette` is dead** — one reader in `App.tsx:60`, never used.

7. **Unused imports**: `value` in `settingsCommands.ts`, `panel` in
   `globalEditorCommands.ts`, `panel`/`value` in `agentStatusCommands.ts`.

---

## What is already correct — copy these

`tiled-tabs` (`tileTabsCommands.ts:5-22`) is the template for a surface whose
open and close go through *different* actions: read state, branch, call the
right one-directional action. Every modal in Layer 3 needs exactly this shape.

`dispatch-mode` (`layoutCommands.ts:5-28`) is the same with a non-boolean state.
`toggle-git-bar` (`sessionCommands.ts:913-921`) is the trivial case when a real
toggle action exists.

---

## Phases

1. **Palette mode → store.** Fixes the 9 no-ops, including ⌥P and ⌘⇧R.
2. **Ownership-gate escape** for a chord whose command owns the open surface.
   Without this, nothing in phase 4 is reachable by keyboard.
3. **Flags + close actions** on the command context — the 25 gaps, ids not just
   predicates for the 9 session-scoped ones.
4. **Toggle conversions + `getState`** for the surface commands that should
   round-trip, honouring the must-not-toggle list.
5. **The seven discrete bugs.**

Phase 5 is independent and can land first. Phases 2 and 4 are useless apart.

---

## Outcome (2026-07-26)

All five phases landed. Commits `1319dbba`, `34c600c2`, `f342a6fd`, `8ac304b3`
on top of this plan.

Verification: `tsc -b` clean on both projects after `rm -rf .tsc-out`,
`check:keybindings` OK (39 binding sets, 13 reserved, 5 approved overlaps),
246/246 vitest files.

### Decisions taken during implementation

**Phase 1 chose store-backed mode over the three-edit patch**, as planned. Worth
recording why the alternative kept looking attractive: it touches fewer files.
It also has three parts that must all be present, and its correctness argument
is "passive effects run after layout effects". The store version has no ordering
argument at all, which is the entire reason to prefer it.

**Phase 2 used a table, not a derived predicate.** Asking the command
(`getState(ctx)?.value === 'on'`) would be impossible to drift, and was
rejected anyway: building a `CommandContext` assembles ~76 workspace actions,
and deferring that is why the router forwards an id instead of dispatching
inline (#494). Paying it on every keystroke that lands while a dialog is open
trades a real regression for a keyboard nicety. Drift is bounded by
`keyof UiShellState` instead.

**The close-after-run exemption became a live-flag read** rather than a longer
id list. `PALETTE_SELF_EXCLUDED_COMMAND_IDS` held only `open-command-palette`
and would have needed all nine mode-entering commands added to it — an
enumeration someone has to remember. "Did this command turn the palette on?"
answers for all of them and for anything added later. The set survives for its
original, separate purpose: keeping "Command Palette" out of its own list.

### What the tests actually pin

The store tests drive `setPaletteMode` / `closeCommandPalette` /
`requestCommandInvocation` rather than rendering the palette, deliberately: the
bug was never a rendering bug, it was state carrying a component lifecycle it
should not have had. Verified by sabotage — removing the `commandPaletteOpen`
coupling from `setPaletteMode` fails two cases.

The surface-ownership test asserts every listed command has a `getState`. It
failed on its first run and caught `usage.open` toggling with no badge, which
is the failure mode worth guarding: the table lets a chord cross the
interaction gate, and the command's state and run are what dismiss once it
does. Listed-but-not-toggling is the reported bug wearing a different hat.

### Not done, and why

`RemotePanel` still renders a Radix `Dialog` while being registered as a side
panel, unlike its sibling `AgentStatusPanel` (`<aside>`). Phase 2's exemption
makes its chord round-trip regardless, so the inconsistency is now cosmetic
rather than functional — but it is still the wrong component for a non-modal
panel, and worth its own change.

Escape does not dismiss the Settings page: `useKeybinds.ts:537-541` is dead code
behind the ownership gate, and the only exit is the Close button. Left alone
because Settings is deliberately excluded from the toggle set, so fixing it is
about Escape rather than about activation semantics.

`save-editor-file`'s `when` is now correct, but the underlying design — a window
event with a listener that exists only while the editor is mounted — is still
the reason the guard has to be so precise.


---

## Review round (2026-07-27)

Two orchestrated reviewers (Claude + Codex) read the branch independently.
Codex: 0 critical, 2 high. Claude: 10 findings, none breaking types or tests.
Both ran `tsc -b` (Claude also `--force`), `check:keybindings` and the full
suite, all exit 0. Every finding was judged valid and fixed.

### The two that mattered

**The headline rule was delivered for half the bug report.** Phase 1 turned ⌥P
and ⌘⇧R from *nothing* into *opens*; the second press still did nothing, because
the palette is itself a dialog and no palette-mode command was in the ownership
table. Worse, ⌥P's second press typed `π` into the query — Alt chords over a
text target are not preventDefault-ed, so the keystroke composed. The nine
commands now compare `flags.paletteMode` and dismiss, via a SECOND table
(`PALETTE_MODE_COMMANDS`).

That split was itself found by a failing test. Merging the two kinds of
ownership into one map type-checked and was wrong: it implied Resume Session
should carry an Open/Closed badge, when "the palette is open" is not a property
of Resume Session. These commands do not own a surface with its own flag — they
own a MODE of one shared surface.

**Phase 2 only exempted keybindings.** The native-menu handler had its own copy
of the ownership bail, so File → New Tab twice left the picker up. "Every
invocation source" was false for the menu — in a PR whose title is that phrase.

### The rest

- The table's `keyof UiShellState` accepted any of ~40 keys, including the nine
  `SessionId | null` ones where `=== true` is permanently false — silent, and
  exactly the failure its own test claimed to guard. Narrowed to boolean-valued
  keys only; verified by sabotage that a nullable flag now fails to compile.
- The mount-reset effect was UNREACHABLE (`mountedForPendingCommand` is never
  false, because `openCommandPalette`'s only caller is a command, and commands
  run from inside an already-mounted host). Its state resets were redundant, but
  its `requestAnimationFrame` focus call was not — focus now keys on `visible`.
- `new-tab` was REMOVED from the toggle set. `pathPickerOpen` means "the shared
  path modal is open", not "the new-tab picker is open" — the same
  boolean-loses-information problem the session-scoped surfaces were kept out
  for. Live consequences: ⌘T dismissed the picker mid-submit during a slow
  spawn, and a create action had started rendering an Open/Closed badge.
- `toggleCommandPalette` was deleted. Phase 5 removed its only reader and Phase 1
  then added new behavior to it — mechanism-with-no-consumer, in the sweep whose
  whole purpose is finding that shape.
- `openResumePicker`'s removal had left `onResumeRequest` destructured and in a
  memo dep array.
- The live-flag close rule holds only for a command that opens the palette in its
  SYNCHRONOUS prefix; the comment asserted it unconditionally. Now stated.
- One dep array was wrong and misindented — in the commit whose stated
  discipline is that missing a dep is a silent staleness bug.

### Test added

Nothing proved a toggle's `run` closed the RIGHT surface — a copy-paste closing
someone else's would have passed. The new case drives every listed command with
its own flag true and asserts exactly one dismissal and no open. It caught a real
distinction on first run (Remote Panel legitimately uses a `toggle*` rather than
a `close*`), and is sabotage-verified.

### Accepted, not fixed

`executePromptTemplate` sets its mode after an `await`, so a dismissal during
that window could resurrect the palette into a mode whose component-local data
is gone. Unreachable today — both built-in templates declare `variables: []`, so
the awaiting branch cannot be entered. It is the structural cost of Phase 1 that
this plan did not name: the mode is store state while everything the mode needs
is still component state. Recorded here rather than papered over.
