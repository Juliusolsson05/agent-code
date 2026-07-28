# Mouse-First Workspace Implementation Plan

> **Status:** IMPLEMENTED on `feat/mouse-first-workspace` (PR #617). All six
> workstreams landed. Q1 below is still open and does not block anything.
>
> **Where the implementation diverged from this plan**, so the next reader
> trusts the code over the doc:
>
> - **The chord's settings control is a `select`, not a capture control.** The
>   plan implied a `MouseButtonInput` sibling. The chord vocabulary is a closed
>   two-item set, so there is nothing to discover by pressing — capture only
>   earns its complexity for the dictation row, where nobody can tell which
>   physical thumb button reports DOM button 3 versus 4.
> - **`DictationTargetHandle` gained `cancel()`.** The plan said a chord should
>   cancel the nascent dictation hold but did not notice that no discard path
>   was reachable from the registry: `stop()` finalizes the provider stream and
>   pastes the result. Cancelling needed a real second verb.
> - **`ReorderTabsModal` got per-row ↑/↓ buttons as siblings of the row, plus a
>   new `moveTabById`.** The existing `movePickedTab` reads `movingTabId`, which
>   only Enter can set — reusing it would have left the dialog keyboard-gated in
>   exactly the way the audit flagged.
> - **`TiledDispatchCountOverlay` now holds a number, not a string.**
>   `NumberInput` owns parsing and clamping; keeping a parallel string would
>   mean two places deciding what "not a number yet" means.
> - **The stale xterm claim in `useDictationMouseTrigger` is gone.** That
>   comment justified suppression partly as keeping middle-click out of xterm's
>   X11 paste; xterm guards that behind `isLinux`, so it never applied on macOS.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Code drivable with a mouse alone — a user leaning back with one hand on the mouse can read a feed, send a prompt, stop a runaway agent, switch agents, create an agent, and reach any command without touching the keyboard.

**Architecture:** One new shared mouse arbiter, two new UI primitives, and a set of affordances added to surfaces that already exist. Nothing is rewritten. The single highest-leverage change is a mouse route into the command palette, because that one gap currently strands ~60 commands.

**Tech Stack:** TypeScript, React 18, Zustand, DOM Mouse/Pointer Events, Radix Dialog. No new dependency.

---

## Global Constraints

- **No new test files in this PR.** Standing repo preference: feature/fix PRs do not add test files or wire new `test:*` scripts; a test-cleanup PR is planned separately. Where a behavior would deserve a test, the task says so explicitly so the cleanup PR inherits the list.
- **Verification is `npx tsc -b`** (exit 0) plus the existing suite green, plus `npm run check:keybindings` for any command work. `electron-vite build` and vitest do **not** type-check, and plain `tsc -p tsconfig.web.json` fails a fresh worktree with TS6305 because the web project references node's build output.
- **Comment policy** (`CLAUDE.md`): thick WHY comments explaining why the shape is what it is and what would make it wrong. Never narrate what the code does.
- **Command/settings copy** (`docs/command-style.md`): stable noun phrases, no `Toggle`/`Enable`/`Disable` in titles, typographic `…` (a literal `...` fails `naming.test.ts:57-62`), explicit `surface` on every command.
- **Persisted settings fields do NOT require a `store.ts` version bump.** `merge` runs `coerceSettings` unconditionally on every hydration. Bump only when a value is reinterpreted or migrated.
- **Adding any command requires updating `catalog.test.ts` in the same commit** — it pins `BASELINE_COMMAND_IDS` as an ordered snapshot *and* asserts `toHaveLength(99)`. It also asserts `experimental === 1`, so a second experimental-tier command fails the suite.
- **`border-radius` is banned repo-wide.** Every new control is sharp-edged.

---

## Verified hardware evidence

Captured 2026-07-28 with a purpose-built DOM probe on the product owner's actual mouse. **These are measurements, not assumptions.**

| Finding | Evidence |
|---|---|
| Middle button works cleanly | `pointerdown button=1 buttons=4` / `pointerup button=1 buttons=0`, seven identical cycles |
| **Side buttons produce ZERO events** | Two dedicated 10-second windows, nothing recorded. Back/Forward never reach Chromium on this hardware |
| The middle+right chord IS detectable | `mousedown button=1 buttons=6` and `mousedown button=2 buttons=6` (mask 2\|4) |
| The chord appears only on `mousedown` | No `pointerdown` accompanied any chord press |
| `contextmenu` fires on every right press and is reliably suppressible | Cancelled on 100% of occurrences |

### The pointer-event rule that governs all of this

For a mouse there is **one pointer**, so `pointerdown` fires only on the **0 → non-zero** buttons transition, `pointerup` only on **non-zero → 0** (carrying whichever button was released last), and every intermediate press or release emits **`mousedown`/`mouseup` only**.

Consequences, both already paid for once in PR #616:

1. **Chords must be built on `mousedown`.** A second button pressed while the first is held produces no pointer event at all.
2. **Release edges must test the `buttons` bitmask, never `event.button`.** This caused a stuck-microphone bug that two code reviews missed and only hardware probing found.

A useful corollary: because the chord's second press emits no `pointerdown`, Radix dialog dismissal and every `pointerdown` consumer (`Feed.tsx:1092`, `ComposerInput.tsx:241`, `TileTabsView.tsx:133`, `MouseButtonInput.tsx:95`) sit the chord out for free. **Only `mousedown` consumers need suppressing.**

### The encoding trap

`MouseEvent.button` and `MouseEvent.buttons` use **different encodings, with middle and right swapped**:

| Button | `button` | `buttons` bit |
|---|---|---|
| left | 0 | 1 |
| **middle** | **1** | **4** |
| **right** | **2** | **2** |
| back (X1) | 3 | 8 |
| forward (X2) | 4 | 16 |

It is **not** `1 << button`. `lib/mouseBinding.ts` carries both maps explicitly.

---

## What the audit found

Eight agents read the catalog, the palette, the dialogs, the dispatch/composer surfaces, the settings and command-governance systems, and every mouse and keyboard handler in the renderer.

### The structural finding

**The command palette cannot be opened with a mouse.** `openCommandPalette` (`app-state/uiShell/slice.ts:76`) has exactly one caller — the `open-command-palette` command (`features/command-palette/commands/paletteCommands.ts:26-34`) — routed only from `Cmd+Shift+P` (`command-keybindings/defaults.ts:82`). There is no button, chip, or menu item anywhere in the renderer that dispatches it.

The native macOS menu exposes **six** command ids total (`shared/commands/nativeMenuCommandIds.ts:22-29`): `new-tab`, `resume-session`, `save-editor-file`, `save-all-editor-files`, `reorder-tabs`, `close-tab`.

The catalog holds **98 commands**. So **~60+ have no mouse path at all**, and the container that would reach them is keyboard-gated. Compounding it, `pickerVisibility: 'advanced'` commands are hidden from the palette list by default — `bury-pane`, `revive-pane`, `kill-buried-pane`, `linked-agent`, `normalize-layout`, `rotate-layout`, the AI-workspace trio and more are keyboard-only *twice over*.

**This is why the chord is workstream 1 and not a nice-to-have.** Every other fix in this plan is worth less until there is a mouse door into the palette.

### Commands a mouse literally cannot complete

| Command | Why |
|---|---|
| `attach-detached-to-grid` | Lands directly in the placement step. **Zero interactive elements exist** — preview is `pointer-events-none`, targets move on arrows, commit is Enter, cancel is Escape |
| `new-agent` (grid mode) | Kind picker is clickable; placement step is not. Backdrop has **no `onClick`**, so a mouse user who picks a kind cannot commit *or* cancel |
| `pin-agents` | Rows toggle on click, but `onCommit` fires only from the Enter branch of `usePinAgentsKeybinds.ts`. No confirm button. The only mouse exit is the backdrop, which **silently discards the whole selection** |
| `reorder-tabs` | Rows are clickable but only move a cursor. Picking is Enter-only, moving is Arrow-only. A mouse user can open it, click around, and commit the *unchanged* order |
| `copy-assistant-message` | Driven exclusively from `useKeybinds.ts:463-487`. Selection is a CSS outline toggle; no click handler on any node |
| `copy-code-block` | Same — `useKeybinds.ts:502-547`. Blocks are enumerated with `data-code-block-id` but never made clickable |
| Slash-command picker | `SlashCommandPicker.tsx:49-75` renders `role="option"` items with **no `onClick`**. Visible, unpickable |

### Critical-path blockers outside the dialogs

1. **No send button.** `submitCurrentDraft` has three call sites, none of them a control. The only mouse route to send is the accidental one — clicking a `PromptSuggestionChip` when the app happens to offer one *and* auto-send is enabled.
2. **No stop/interrupt control.** Escape / Ctrl+C / Ctrl+D only (`useComposerKeybinds.ts:432-459`). **A mouse-only user cannot cancel a runaway turn.**
3. **Reader Mode and Spotlight have neither an open nor a close affordance.** Both are chord-in, Escape-out. A mouse user who reaches either is trapped.
4. **Settings has no gear.** `SettingsBar.tsx:20-87` holds usage / appearance / perf / caffeinate and nothing else; `Cmd+,` is the only door.
5. **Tail toggle and jump-to-latest have no affordance** — the `TAIL` pill in `ScrollIndicator.tsx:90-97` is a `<span>`, not a button.

### The primitives question, answered

**There is no shared confirm/cancel footer and no numeric stepper anywhere in the codebase.**

- `DialogFooter` (`components/ui/dialog.tsx:87-98`) is a bare flex `<div>` — layout only, zero buttons, zero semantics. Thirteen call sites hand-write their own pairs across **six cancel labels** ("Cancel", "Skip", "close", "Close", "Esc", "✕") and four variants. Four dialogs have no footer at all.
- There is **not a single `<form>` element in the entire renderer**, so native submit-on-Enter is never used and **sixteen** dialogs hand-write their own Enter-to-confirm. `DebugBundleNotePrompt` requires **Cmd+Enter** where every sibling uses plain Enter — confirm semantics are per-dialog folklore.
- `type="number"` appears exactly twice, both raw inputs relying on native browser spinners. No `role="spinbutton"`, no increment/decrement control, no numeric control type in the settings registry.
- `showCloseButton` on the shared dialog **defaults to `false`** and has exactly one adopter (`QueueStrip.tsx:68`).

So workstream 6 is **"build two primitives, then apply them"** — not N bespoke fixes.

### Parity is not a house rule

Worth knowing before anyone objects that this work is unprecedented: the codebase does **not** enforce keyboard/mouse parity in either direction. The tile-tree divider (`TileTree.tsx:275-278`) has `role="separator"` and `onMouseDown` but no `onKeyDown` and no `tabIndex`. Dispatch split handles mount without `onKeyboardDelta`, so they are mouse-only. Adding mouse paths violates nothing.

---

## Decisions

### D1 — Mouse triggers are in-app only, never global
Electron's `globalShortcut` cannot register mouse buttons; a global trigger would need the Accessibility-gated CGEventTap helper, making the feature macOS-only behind a permission prompt. Settled — PR #616 shipped on it.

### D2 — Left and right click are never bindable *alone*
Runtime listeners `preventDefault()` on a match, so binding left would swallow every click in the app and binding right would swallow the context menu, including the clicks needed to undo it. A **chord containing right is different** — suppression is bounded by the other button being held. The rule is "never bindable alone", not "never bindable".

### D3 — Starred commands hard-pin on empty query, score-boost during search
Hard-pinning during an active search would let a star outrank an exact title match, breaking the one property a palette cannot lose. `rankEntries.ts:259-261` states this as the cardinal rule. Empty-query ordering has no such constraint.

**D3a** — the boost rides the existing `extraTiebreak` hook, never a new sort key. History scores are bounded in `[0,1)`, so `STAR_WEIGHT = 1` puts starred above unstarred *within a tier* while never crossing tiers.

**D3b** — the empty-query case is a stable partition in `rankCommands.ts`, **not** an edit to `rankEntries.ts:272`. Five lists share that short-circuit.

**D3c** — starring may perturb resting order even though recency may not. `rankEntries.ts:270-272` refuses automatic reshuffling because "the row you expect at the top moves before you've typed a character." A star is a *deliberate act by the same user now looking at the list*. **This reasoning must be written into the code**, or it will be reverted as a rule violation.

**D3d** — the star map does **not** go in `CommandContext.flags`. Visibility lives there because it is consumed inside `buildCommandRegistry`; starring is applied after. Putting it in flags would rebuild all 99 commands on every toggle.

### D4 — "Mouse Mode" gates only the composer send button, and gets no palette command
Gating everything behind a mode creates two UIs to keep correct forever. Steppers, the dispatch "+", and starring are harmless always-on. Only the send button is genuine visual noise for a keyboard user.

**It must not also become a palette command.** Durable preferences with no momentary scope were deliberately retired from the catalog — five of them (`taxonomy.test.ts:218-253`). A settings row only.

### D5 — One shared mouse arbiter, not two racing capture listeners *(revised after the conflict map)*

`useDictationMouseTrigger` mounts at `App.tsx:68` and, when middle is bound, calls `preventDefault()` + `stopPropagation()` on the middle `mousedown`. Window-capture listeners fire in **registration order**, so a chord listener added later would **never see the press**. This is not a UX conflict to paper over — two independent capture listeners racing on mount order is the wrong shape.

**Decision:** extract a single window-capture mouse arbiter that owns all multi-button state and dispatches to both dictation and the chord. This is the same argument `dictationHotkeyRegistry.ts:9-11` already makes for having one dictation dispatcher rather than two sources "each believing they own the same recording."

The arbiter resolves the middle-button contention directly: it holds the press, and if a second button arrives within the chord window it routes to the chord and **cancels the nascent dictation hold** instead of letting both fire.

### D6 — The chord is workstream 1 because it is the keystone
~60 commands have no mouse path and the palette is keyboard-gated. Every other affordance in this plan is worth less until that door exists.

### D7 — Workstream 6 builds two primitives first
`DialogActions` (confirm/cancel footer owning Enter/Escape once) and `NumberInput` (a stepper). The footer alone replaces sixteen hand-written Enter handlers and gives every dialog a guaranteed clickable exit as a side effect.

### D8 — Accept the terminal mouse-reporting cost, and say so out loud
xterm in mouse-reporting mode forwards buttons 0/1/2 **straight to the child process**. A chord that stops propagation at window capture silently swallows both buttons from any agent TUI actually using the mouse. This is the one genuinely user-visible cost of the chord and it is accepted, not hidden. The arbiter should suppress only when the chord actually fires, never speculatively.

### Q1 — OPEN QUESTION for the product owner

On the product owner's hardware the middle button is the **only** usable extra button — side buttons produce nothing. Two features want it: middle-hold for dictation (shipped), middle+right for the palette (this plan).

The arbiter makes both work, but every palette open still costs a nascent dictation start and a brief macOS mic-indicator blink. **Either:**

- **(a)** keep middle bound to dictation and accept the blink, or
- **(b)** leave middle purely for the chord and keep dictation on the keyboard.

Implementation differs only in whether the cancel path is exercised in practice. **This does not block starting workstreams 2–6.**

---

## Scope

**In scope for this PR:**

| # | Workstream | Why |
|---|---|---|
| 1 | Mouse arbiter + chord → command palette | D6, the keystone |
| 2 | Command starring | Product ask |
| 3 | Dispatch project-tab "+" | Product ask |
| 4 | Composer send button + Mouse Mode setting | Product ask + critical-path blocker |
| 5 | Stop/interrupt control | Critical-path blocker found by audit; a mouse user currently cannot stop a runaway agent |
| 6 | `DialogActions` + `NumberInput` primitives, applied to the four hard-failure dialogs | D7 |

**Explicitly deferred**, with reasons:

- **Reader Mode / Spotlight exit affordances, Settings gear, tail-pill button, feed per-message actions.** Real gaps, but each is an independent small fix and none blocks the lean-back loop once the palette is mouse-reachable. A follow-up PR.
- **Path picker parent-directory navigation.** The picker has no `..`, no breadcrumb, and no native browse dialog (`showOpenDialog` appears nowhere in the repo), so a mouse user is locked into the pre-filled subtree. Genuinely blocking for *new tab*, but it is a self-contained design problem deserving its own plan.
- **Clickable placement targets in `NewAgentPlacementOverlay`.** `:296-306` records that clickable target rectangles were **deliberately removed** because "rendering every target as a clickable rectangle made those operations overlap." The naive fix is the thing already tried and reverted. This needs a design that respects that scar, not a revert. **What this PR does instead:** give the overlay a working mouse *cancel* (backdrop click + a Cancel button), so a mouse user is never trapped — which is the actual harm.
- **`copy-assistant-message` / `copy-code-block` click-to-select.** Straightforward (`onClick` on the already-enumerated nodes) but touches feed rendering, which carries its own fixture-first discipline (`docs/rendering/rendering-design-principles.md`). Not to be done casually inside a mouse PR.

---

## Workstream 1 — Mouse arbiter and the palette chord

### Files
- Create: `src/renderer/src/lib/mouseArbiter.ts`
- Modify: `src/renderer/src/lib/mouseBinding.ts` (chord vocabulary)
- Modify: `src/renderer/src/features/voice-dictation/useDictationMouseTrigger.ts` (consume the arbiter)
- Create: `src/renderer/src/features/command-palette/useMouseChordPalette.ts`
- Modify: `src/renderer/src/app/App.tsx` (mount order)
- Modify: `src/renderer/src/app-state/settings/types.ts`, `persistence.ts` (the chord binding setting)

### Design

One module owns every window-capture mouse listener. It tracks the `buttons` bitmask across `mousedown`/`mouseup`, and exposes subscription for two consumer kinds: **hold** consumers (one button, press-and-release — dictation) and **chord** consumers (two buttons simultaneously — the palette).

The arbiter's central rule: **a chord win cancels any hold that the first button started.** When middle goes down it notifies the hold consumer optimistically; if right arrives before the hold has produced anything durable, the arbiter issues a cancel to the hold consumer and fires the chord instead.

- [ ] **Step 1: Add the chord vocabulary to `mouseBinding.ts`**

Extend with a chord type and its mask, reusing the existing `MOUSE_BUTTON_MASKS` table:

```ts
/** A two-button chord, stored as its `buttons` bitmask sum. Middle+Right is
 *  mask 4|2 = 6 — verified against hardware. Stored as an explicit union
 *  rather than an arbitrary mask so the settings surface stays a closed set
 *  and D2 (right is never bindable ALONE) stays structurally true. */
export type MouseChordBinding = '' | 'Middle+Right'

export const MOUSE_CHORD_MASKS: Record<Exclude<MouseChordBinding, ''>, number> = {
  'Middle+Right': MOUSE_BUTTON_MASKS.Middle | 2,
}
```

- [ ] **Step 2: Build the arbiter**

`mouseArbiter.ts` owns the listeners currently inside `useDictationMouseTrigger`'s effect: capture-phase `mousedown`/`pointerdown` (down), `mouseup`/`pointerup`/`pointercancel` (up, bitmask-tested), `auxclick` (suppression), plus `blur` and `visibilitychange`. It additionally listens for `contextmenu` and cancels it **only while a chord's first button is held**.

Registration API:

```ts
registerHoldConsumer({ mask, onPress, onRelease, onCancel }): () => void
registerChordConsumer({ mask, onFire }): () => void
```

WHY comments must cover: registration-order fragility (the reason this module exists), the `mousedown`-not-`pointerdown` rule for the second button, bitmask-not-`event.button` on release, and D8's rule that suppression happens only on an actual match.

- [ ] **Step 3: Re-point dictation at the arbiter**

`useDictationMouseTrigger` keeps its release-safety semantics but registers as a hold consumer instead of installing its own listeners. Its `onCancel` discards the nascent recording via the existing `cancelRecording` path — the same one the 180 ms tap-discard uses, so no provider socket is opened for a chord.

**Delete the stale claim** in that file's `onDown` comment that suppression "keeps middle-click out of xterm's X11-style paste": xterm guards that behind `isLinux`, so it never applied on macOS. The suppression is still correct for the editor-tab and markdown-link cases below; the stated reason was wrong.

- [ ] **Step 4: The chord consumer**

`useMouseChordPalette` registers a chord consumer whose `onFire` calls `useAppStore.getState().openCommandPalette()` — the direct store action (`uiShell/slice.ts:76`), not the command-routed path, which would mount the whole ~76-value palette context just to reach the same action (the thing #494 was about).

Note the semantics: `openCommandPalette` is idempotent when the palette is already in default mode, but **resets an open sub-mode back to the command list**, which is deliberate (`slice.ts:74-75`). There is no toggle action. Consult `hasAppInteractionOwner()` with the same `commandOwnsOpenSurface` exemption used at `CommandPalette.tsx:176-179`, so the chord can still reach the palette while the palette itself is open.

- [ ] **Step 5: Suppress the two behaviors a chord would break**

Middle-click closes an editor tab (`EditorTabs.tsx:126-130`) and middle aux-click opens a rendered markdown link (`SafeMarkdownLink.tsx:100`). Both are `mousedown`/`auxclick` consumers, so the arbiter's existing suppression covers them **provided** it suppresses on match. Verify by hand — these are the two most likely regression reports.

- [ ] **Step 6: Settings row**

A `mouse-chord` control mirroring `MouseButtonInput`, or — simpler and preferred — reuse the existing `select` control with two options (`Off`, `Middle + Right`), since the chord vocabulary is a closed two-item set and does not need capture. Category `workspace`, no `metadata` block.

- [ ] **Step 7: Verify**

`npx tsc -b` exit 0; full suite green; `npm run check:keybindings` clean (it validates the dictation binding against command chords and would catch a collision).

Manual: bind the chord, confirm the palette opens over the grid, over a terminal pane, and while a dialog is open; confirm an editor tab does not close; confirm a markdown link does not open; confirm dictation still works alone and is cancelled cleanly by a chord.

---

## Workstream 2 — Command starring

*(Task detail unchanged from the earlier draft — evidence, D3a–D3d, and the three tasks below.)*

### Task 2.1: Persist the starred set
`settings/types.ts` gains `commandStarred: Record<string, boolean>` (sparse, absent ≡ false) defaulted `{}`; `persistence.ts` gains `coerceCommandStarred`, a clone of `coerceCommandVisibilityOverrides:268-276` with one addition — a persisted `false` is **dropped**, since for stars the default is always false and storing it carries no information. Add the map to the `RETIRED_BUILT_IN_COMMAND_IDS` prune or retired ids accumulate forever.

### Task 2.2: Apply starring to ranking
`rankCommands.ts` takes a fourth `starred` parameter. Non-empty query folds `STAR_WEIGHT = 1` into the existing `extraTiebreak`. Empty query does a stable two-pass partition (starred first, catalog order preserved within each part) because `rankEntries.ts:272` returns early without sorting. Read `settings.commandStarred` near `CommandPalette.tsx:312` and add it to the `filteredCommands` deps at `:888` — **not** to `commandContext.flags` (D3d).

The D3c rationale goes in the code as a comment, verbatim.

### Task 2.3: The star button
`CommandDescriptionPanel` (`CommandPalette.tsx:2012-2049`) gains `starred` and a `useCallback`-stable `onToggleStar` (an inline arrow defeats its `memo` and re-renders the pane on every keystroke). The header block at `:2035-2041` becomes `flex items-start justify-between`; the star is the trailing child. Suppress it for transient rows via `isAgentIndexCommand` (`lib/agentIndexCommand.ts:37`) — starring `agent-index:abc123` would write a permanently dead key into settings.

**Known limitation, recorded not fixed:** the detail pane is `hidden md:block` (`:2033`), so the star does not exist below the `md` breakpoint. A row-level star would need `stopPropagation` (pattern at `:1945-1947`) and competes for space exactly where space is scarcest. Out of scope.

---

## Workstream 3 — Dispatch project-tab "+"

### The crux: the create-agent flow has no project parameter

`createDetachedDispatchAgent(kind)` (`workspace/hook/actions/pane.ts:536-601`) resolves its target implicitly via `resolveDispatchSpawnTarget` (`dispatchSelectors.ts:351-389`).

**The cheap fix is a trap.** "Focus that project, then open the flow" works in classic Dispatch and **silently spawns into the wrong project in Tiled Dispatch**: `focusDispatchSession` writes `activeTabId` and `dispatchMode.focusedSessionId` but never touches `tiled.lanes`/`focusedLane`, and the tiled branch returns before ever reading `focusedSessionId`. It also moves the user's selection as a side effect of clicking "+".

**Do it the way the codebase already solved this.** `dispatchAttachIntent` (`uiShell/types.ts:4-7,115-123`) exists for exactly this reason and its doc comment says so: the target tab must be captured up front *because tiled lane selection does not mutate `activeTabId`*.

- [ ] **Step 1** — add `newAgentProjectTabId: TabId | null` to uiShell with open/close actions, mirroring `dispatchAttachIntent`. Clear it in `usePlacementOverlay`'s `close` alongside the other intents.
- [ ] **Step 2** — thread it through both `NewAgentPlacementOverlay` mounts (`MainSurface.tsx:99-105` and `:118-124`) and consume it in `commitKind`'s dispatch branch (`NewAgentPlacementOverlay.tsx:142-169`).
- [ ] **Step 3** — widen `createDetachedDispatchAgent` to accept a tab override **and a cwd anchor**. Overriding the tab id alone is insufficient: `cwd` is computed at `pane.ts:548-554` from the *focused* session, and Dispatch agents are detached (never in `tab.root`), so a project whose grid leaves are all closed hits the `'no project directory found'` toast. Pass `group.rows[0].sessionId` as the anchor — the header already has `rows` in scope. Keep `laneIndex` from `resolveDispatchSpawnTarget` so tiled placement still works.
- [ ] **Step 4** — the button itself, in `DispatchGroupHeader` (`DispatchAgentList.tsx:161-186`), inserted between the title `<span>` (`:180`) and the count `<span>` (`:181-183`). The header is a plain `<div>` with **no `onClick`**, so no `stopPropagation` is needed and there is no button-in-button hazard. Style after `TabBar.tsx:136-149`. Give it `flex-shrink-0` so the truncating title absorbs the squeeze; the row is `py-1` at `text-[10px]` (~18px), so the control must be `h-4 w-4`.

**Three constraints on where it appears:** the same header renders the **Pinned** section (`:124`), which is not a project — pass the tab id explicitly and render nothing when null. The multi-project strip only exists in **global** dispatch scope. And `.filter(group => group.rows.length > 0)` (`dispatchSelectors.ts:142`) means a project with zero agents has no header, so this button can never create the *first* agent in a project.

Do **not** tag it `data-dispatch-row` — `composerEnterRegistry.ts:25-52` exempts those from the interactive-target bail, and this is a genuine action button.

---

## Workstream 4 — Composer send button and Mouse Mode

- [ ] **Step 1: The setting.** `mouseModeEnabled: boolean`, default `false`, coerced `parsed.mouseModeEnabled === true`. One `toggle` row in category `workspace`, no `metadata` block. **No palette command** (D4).

- [ ] **Step 2: The button.** `ComposerInput` is **shared with the phone client** (`remote-client/src/ui/SessionView.tsx:407` renders the same component), which already has its own Send at `:487`. A button added inside `ComposerInput` unconditionally would double it. Make it an optional prop that only `TileLeaf` passes, or a sibling row in `TileLeaf` the way the phone does it.

Placement: a new flex row **below** the input row, sibling of the `div.relative` at `ComposerInput.tsx:171-259`. The right edge is already claimed by `ComposerDictationActivity` (`absolute right-2 w-12`) with the textarea's `pr-16` tuned to match — an absolutely-positioned button would force that matched pair to be re-derived as a three-way expression. Cost of the row: ~28px of pane height per pane, which is why it is gated.

- [ ] **Step 3: Copy the phone's state model verbatim.** `SessionView.tsx:487-489` is the shipped answer: `disabled={!draft.trim() || sending || deliveryUncertain || transcript.exited}`, label `{sending ? '…' : 'Send'}`. The `sending` equivalent on desktop is `runtime.promptDelivery.kind === 'sending'`, already passed into `ComposerInput` as a prop — no new plumbing.

- [ ] **Step 4: Guard slash mode — this one is a real bug if missed.** `submitCurrentDraft` does **not** guard slash mode; only the Enter registry does (`TileLeaf.tsx:540`). A send button that ignores `slashMode` would run the normal submit path against text the PTY already owns. Disable on `slashMode`, and on `providerSwitch` (which already disables the textarea at `:208`).

- [ ] **Step 5: `onMouseDown={e => e.preventDefault()}`** so clicking does not steal focus from the textarea — otherwise `focused` churns, the accent border drops, and `composerEnterRegistry.ts:88-100` starts bailing on bare Enter because an interactive element holds focus.

- [ ] **Step 6:** add `'button'` to the `source` union at `useComposerKeybinds.ts:143`. It is recorded into the paste-debug journal at `:191-204`, and keeping click-submits distinguishable from Enter is exactly what that journal is for.

---

## Workstream 5 — Stop control

A mouse-only user currently cannot interrupt a running agent — Escape / Ctrl+C / Ctrl+D only (`useComposerKeybinds.ts:432-459`).

The phone already solves this: `SessionView.tsx:482-486` renders a **Stop** button only while `working`, calling `feed.sendInput(sessionId, '\x1b')`. Mirror it in the same composer action row as the send button, visible only while the agent is working (`runtime.streamPhase`/`sessionStatus`, the same predicate `DispatchAgentList.tsx:169-176` uses).

Gate it behind Mouse Mode alongside Send, for the same reason.

---

## Workstream 6 — Dialog primitives and application

### Task 6.1: `DialogActions`

A confirm/cancel footer owning `{confirmLabel, onConfirm, cancelLabel, onCancel, tone, busy, disabled}`, wiring **Enter-to-confirm and Escape-to-cancel once**. Replaces sixteen hand-written Enter handlers and, as a side effect, guarantees every adopting dialog a clickable exit.

House-style decisions this must settle, because there is currently no convention: cancel is always labelled "Cancel" (not "Skip"/"close"/"Esc"), cancel is always the `ghost` variant, destructive confirms are always `destructive`, and the confirm is always the right-hand button.

### Task 6.2: `NumberInput`

A stepper with visible `+`/`−` buttons, `min`/`max`/`step`, `role="spinbutton"` and `tabular-nums`. Zero prior art — the two existing `type="number"` inputs rely on native browser spinners, which are small, inconsistent across platforms, and easy to mis-hit.

### Task 6.3–6.6: Apply to the four hard failures

| Dialog | Fix |
|---|---|
| `pin-agents` (`PinAgentsModal.tsx:141-153`) | Replace the `<kbd>` legend with `DialogActions`; wire confirm to the existing `onCommit`. **The highest-value single fix in this workstream** — a mouse user can currently build an entire selection and then lose it |
| `reorder-tabs` (`ReorderTabsModal.tsx:189-196`) | Add per-row ↑/↓ buttons calling the existing `movePickedTab` |
| `new-agent` / `attach-detached-to-grid` (`NewAgentPlacementOverlay.tsx:384-388`) | Add a backdrop `onClick` and a Cancel button so a mouse user is never trapped. **Do not** add clickable placement rectangles — see the deferred-scope note |
| `tiled-dispatch` (`TiledDispatchCountOverlay.tsx:89-99`) | Swap the raw `type="number"` for `NumberInput`. This is the product owner's original stepper example |

---

## Self-Review

**Coverage of the original asks:** chord → palette (W1), star system (W2), dispatch "+" (W3), send button + Mouse Mode (W4), dialog stepper example and the broader sweep (W6). All five present.

**Additions the audit forced:** the mouse arbiter (D5 — the chord is otherwise unreachable when middle is bound), the stop control (W5 — a mouse user cannot currently stop an agent), and the two primitives (D7).

**Type consistency:** `MouseChordBinding`/`MOUSE_CHORD_MASKS` produced in W1 and consumed by the arbiter; `commandStarred` produced in 2.1 and consumed in 2.2/2.3; `newAgentProjectTabId` produced in 3.1 and consumed in 3.2/3.3; `mouseModeEnabled` produced in 4.1 and consumed in 4.2/W5.

**Known open item:** Q1 (whether middle stays bound to dictation). Does not block any workstream.
