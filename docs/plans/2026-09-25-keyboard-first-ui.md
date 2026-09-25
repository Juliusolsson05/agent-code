# UI: every surface is keyboard-operable, labelled, and visually consistent

Refs #1220 (tracking issue), Refs #512 (floating-surface unification — the Radix migration did most of it;
this finishes the keyboard/labels half), Refs #713 (condition modal traps all
input — keyboard side owned here, functional side coordinated with B7).
Branch `feat/keyboard-first-ui` · Worktree `.worktrees/keyboard-first-ui` ·
Base `origin/main` @ e3579837 (2026-09-25)
Status: in progress — long goal loop. PR opens as draft; **the owner merges
personally** (it changes how the whole app feels). Never auto-merge.

## Outcome

Every modal, dialog, picker, list, menu and one-shot action in the renderer
can be driven with the keyboard alone, and every surface shows — compactly,
in the same visual language — which key does what. On the same pass every
surface is brought onto one set of spacing, width, radius, type and focus
rules so dialogs stop looking like they were written by 40 different authors
(they were).

Concretely, when this merges:

- Opening any surface puts focus inside it on the thing you would act on.
- Escape always leaves the topmost surface and returns focus where it was.
- Enter always commits the one obvious action or the highlighted row; a
  focused button always owns its own Enter.
- Every list moves with ↑/↓ (+ Home/End/PgUp/PgDn, ⌃N/⌃P), every menu opens,
  navigates and closes from the keyboard, every mouse-only affordance has a
  keyboard path and a visible focus ring.
- Actions carry small key chips *inside* their buttons (`Cancel ⎋`,
  `Pin 3 Agents ↵`); keys with no button get one short legend in the footer.
- Dialogs share four width presets, one header/body/footer anatomy, one focus
  indicator, one Cancel/close idiom.

What the owner said vs. what I assumed: the owner asked for full keyboard
operability, clear compact labels, and a consistency pass over padding,
margin, spacing, alignment, radius and focus, surface by surface, in one long
PR. The specific keyboard model (K-rules), hint design (H-rules) and token
rules (T-rules) below are **my** proposals; the ones that change existing
behaviour are listed under Decisions with defaults.

## Evidence (verified, do not re-derive)

Read 2026-09-25 at e3579837. Line numbers are at that sha.

### Infrastructure that already exists (build on it, do not replace)

- `components/ui/dialog.tsx` — Radix Dialog wrapper. Owns portal, focus trap,
  focus restore, Escape, outside-interaction, the
  `data-agent-code-interaction-owner="app"` marker. `DialogContent` default
  `w-[min(520px,92vw)] rounded-float border-border-hi bg-surface`, **no
  padding**; `DialogHeader` `border-b px-4 py-3`; `DialogFooter`
  `flex justify-end gap-2 border-t px-4 py-3`; title 13px, description 11px.
  README (`components/ui/README.md`) forbids feature-level Escape listeners,
  focus traps and backdrops.
- `components/ui/dialog-actions.tsx` — `DialogActions` (ghost Cancel left of
  default/destructive confirm, Enter-confirm scoped to the dialog root,
  `confirmOnEnter`, `busy`, `confirmDisabled`, left `children` slot) and the
  predicates `focusedControlOwnsEnter` / `focusedControlOwnsSpace` (#862,
  #867). **Only 2 of 44 dialogs use DialogActions** (DictationGuide,
  PinAgents).
- `components/ui/button.tsx` — cva variants on `control-*` tokens,
  `rounded-control`, `focus-visible:ring-1 ring-focus-ring`.
- `@shared/keybindings.ts` `displayKeybinding()` (L279) — the one chord
  formatter (⌘⌃⌥⇧ + ←→↑↓ ↩ ⎋ ␣ ⇥ ⌫ ⌦). `resolveEffectiveKeybindings`
  (`command-keybindings/resolve.ts` L93) resolves defaults + user overrides.
  `StarterHintCard` is the reference for live-resolved hints.
- `workspace/tile-tree/useKeybinds.ts` — one document capture listener. Under
  an app-owned surface only `global` chords whose command owns the open
  surface pass; `shouldPreventOwnedApplicationShortcut` (L103) blocks the
  router's own chords (`BLOCKED_META_CODES` ⌘[ ⌘] ⌘E ⌘P ⌘R ⌘T ⌘W, ⌘digits,
  the ⌥ set) but leaves native editing chords alone.
- **Reserved:** ⌥⇧-arrows (macOS word selection) — header L45-52. Full
  reservation table in `command-keybindings/reservations.ts` L77-276
  (⌘1-9, ⌘⌥1-9, Escape = dismiss, native menu/edit chords, terminal ⌃ keys,
  feed picker ↑↓↵). `check:keybindings` only knows this app's bindings.
- Radius tokens (`styles.css` L205-243): `chip` = non-interactive labels **and
  keycaps**, `control` = interactive chrome, `slab` = inset plates, `float` =
  detached surfaces. Grid elements have zero radius forever (hard rule 1).
  Values from the Corners setting (round 9999/6/8/14, soft 3/3/4/6, sharp 0).
- Tests: renderer project = `*.renderer.test.tsx`, happy-dom, Testing Library
  `fireEvent`. **`@testing-library/user-event` is not installed.** Reference
  patterns: `components/ui/dialog-actions.renderer.test.tsx`,
  `features/workspace/ui/focusedCancelEnter.renderer.test.tsx`,
  `workspace/tile-tree/focusModeKeyboardOwnership.renderer.test.tsx`.

### What is inconsistent today (counts from the inventory sweep)

- **Key hints:** no `Kbd` component. Five renderings: unstyled `<kbd>`
  (PinAgents L192), StarterHintCard chip (`rounded-chip px-1 py-[1px]
  text-[9px] font-code`), KeyboardShortcutsModal chip (`rounded-chip px-1.5
  py-0.5 font-mono`), CommandKeybindingsRow (`rounded-control font-mono`),
  plain muted text (palette L1939), prose legends. `font-mono` and
  `font-code` mixed. ~16 UI strings hard-code chords that do not follow a
  rebind (WelcomeEmpty L20 "(⌘T)", TabBar L143, pane.ts L429, TiledDispatch
  L483, PathPicker L405, AgentActivity L377, PocketStrip L36,
  browserPocketCommands L25, controlReference L13, settingsRegistry L853,
  EditorTabs L229, BulkProviderSwitch L673, layoutCommands L95/140/327,
  paneCommands L102/271/310, globalEditorCommands L36/49/82/108/130).
- **Footers:** 2 DialogActions, ~25 hand-written DialogFooter+Button, 8
  hand-built footer divs, 5 with raw `<button>` in three sizes. Cancel is
  ghost/outline/secondary/raw and labelled Cancel/cancel/Skip/Close/close/
  Esc/✕. Close affordance: `showCloseButton` ×4, lowercase "close" header
  button (Usage, Analytics), ✕ (Remote), "Esc" button (CloseOld, Bulk).
- **Enter:** 8 different mechanisms; ~20 dialogs have none. DebugBundleNote
  alone binds ⌘↵.
- **Padding:** body is `px-4 py-3` / `px-4 py-4` / `p-4` / `p-3` / `px-4 py-2`
  / `px-2 py-2`; whole-content `p-6` (PathPicker), `p-5` (Pin, Reorder);
  SetupGate `px-5 py-4`; palette header `px-3 py-2`; CloseConfirmation's body
  has none (flush to the edge, same class as #1188).
- **Widths:** ~20 literals (360 · 380 · 400/560 · 420 · 440 · 460 · 520 · 560
  · 620 · 640 · 672 · 720 · 760 · 780 · 860 · 880 · 1040 · 1240 · 1360) plus
  `max-w-md/lg/xl/2xl/4xl`; `max-w-xl`/`2xl` are **no-ops** against the base
  520px width, so McpServerDialog renders at 520 not 672.
- **Off-token:** GridDispatch + DispatchRowProject use bare `rounded`
  (renders 0), `rounded-[2px]`, `text-fg`, `bg-surface-raised` (undefined
  tokens); AddSkill is entirely square; `.extension-loading-ring` uses
  undefined `--border`/`--accent`.
- **Focus:** global `:focus-visible` outline uses `--theme-accent`, **not**
  `--theme-focus-ring`, so the user's Focus Ring custom-appearance colour is
  ignored everywhere except ring-class elements. Three indicator styles (1px
  outline, 1px ring, 2px outline-accent ×7). `focus:border-accent` on ~12
  inputs (`:focus`, not `:focus-visible`, and accent not focus-ring).
  `outline-none` with no replacement on composer, QuickOpen/ContentSearch/
  Conversations/Explorer/NumberInput inputs and on six scroll/list
  containers.
- **Type:** titles overridden with `font-semibold` ×8, `text-[15px]`,
  `text-[14px]`; descriptions at 10/11/12px.
- **Menus/popovers:** only `@radix-ui/react-dialog` is installed. Every
  menu/popover is hand-rolled: AppearanceMenu (Escape only, focus never
  enters), SkillMenu (**no keyboard at all**, closes on mouseLeave),
  CommandSortControl (good), ExplorerPane context menu (good: autoFocus,
  wrap, Home/End, focus return), PathInput dropdown (good).
- **Native `window.confirm` ×17** (Conventions, CustomSkills, KeyVault,
  SkillsGrid, WorkflowRunRow) — keyboard-operable but off-style and blocking.
- **List navigation:** no shared hook; ~14 surfaces reimplement ↑/↓
  (grep `ArrowDown`), with differing Home/End, ⌃N/⌃P, j/k, clamp/wrap and
  scroll-into-view behaviour.
- **Stale:** `defaults.ts` L253-256 says ⌘⇧D is the dictation default; it is
  `Fn` (`lib/hotkeyBinding.ts:20`). Fix the comment in passing.

The full per-surface inventory is the **Ledger** below; each row records the
current keyboard coverage and visual deviations found by the sweep.

## Decisions

Defaults are what the loop implements. Items that change existing behaviour
are marked **UNCONFIRMED** until the owner (or B7 as second opinion) answers;
the PR body lists them.

1. **Where key labels live** — *Default: chips inside the control they
   trigger, after the label (`Cancel ⎋`, `Pin 3 Agents ↵`); keys with no
   button in ONE footer legend (`↑↓ move · Space toggle`).* Zero extra rows,
   hint sits where the eye already is. Alternative: a legend row per dialog
   (what AgentActivity does) — costs a row and separates key from action.
   UNCONFIRMED.
2. **Keycap look** — *Default: `rounded-chip`, 16px tall, 10px `font-code`,
   `px-1`, `border-border bg-surface-hi text-muted`; inside a filled
   (accent/danger) button the chip goes translucent on the button's
   foreground.* The radius table already names keycaps as `chip`.
3. **Escape with a non-empty filter** — *Default: Escape closes in one press
   everywhere; only an open sub-popup (dropdown, sort menu, palette sub-mode,
   a pending pick) takes the first Escape.* AgentActivity's
   clear-filter-first becomes close-first. Alternative: clear-then-close
   everywhere (Raycast). UNCONFIRMED.
4. **List edges** — *Default: lists clamp at the ends, menus wrap* (WAI-ARIA
   APG listbox vs menu). Today 14 lists clamp and 7 wrap (PathInput,
   placement overlay, Usage rail, Explorer menu, lane ⌥↑↓, sort menu); the
   two wrapping LISTS (PathInput, placement, Usage rail) change to clamp;
   lane ⌥↑↓ is a workspace grammar, not a list, and keeps wrapping.
   Alternative: wrap everywhere.
5. **Sections/tabs inside a dialog** (Settings, Usage rail, Analytics,
   Performance, Remote) — *Default: ⌘[ / ⌘] cycle sections from anywhere in
   the dialog (same meaning as app prev/next tab, and already blocked from
   the workspace under modals), plus ↑/↓ on a focused rail/tablist.*
   Alternative: ⌃Tab/⌃⇧Tab. UNCONFIRMED.
6. **A setting to hide hints** — *Default: no.* Chips are ~16px; a toggle is
   YAGNI until someone asks.
7. **Dialog widths** — *Default: `DialogContent size="sm|md|lg|xl"` (440 /
   640 / 860 / min(1240,96vw)), default `sm`-ish 520 kept as `default`.* 44
   concrete call sites qualify it under the README's "a variant needs a real
   consumer" rule. Full-screen surfaces (Settings, Performance, Agent
   Activity, Conversations) keep an explicit override with a WHY.
8. **`window.confirm` ×17** — *Default: replace with a `ConfirmDialog`
   composed from Dialog + DialogActions (danger tone, focus on Cancel).* One
   look, no blocking native modal. Alternative: leave native.
9. **Hand-rolled menus** — *Default: add `@radix-ui/react-dropdown-menu` as
   `components/ui/dropdown-menu.tsx`, migrate AppearanceMenu and SkillMenu
   (the two broken ones); leave CommandSortControl, ExplorerPane context menu
   and PathInput dropdown (already correct) but converge their visuals.*
   README sanctions headless primitives where interaction is hard (typeahead,
   focus return, nested layering). Alternative: a shared `useMenuKeyboard`
   hook. UNCONFIRMED (new dependency).
10. **#713 (condition modal traps all input)** — *Default: take it as its own
    late ledger row; scope the condition modal to its pane so other panes
    stay keyboard-reachable; tell B7 before starting.*
11. **Hard-coded chord strings** — *Default: resolve every one live through
    the keybinding resolver (H4).* A title like "New tab (⌘T)" lies after a
    rebind.
12. **Type-size convergence** — *Default: dialogs, pickers, menus, settings
    only; the feed/transcript typography is out of scope.*

Second opinion (B7, 2026-09-25, via ask-1): **agrees with D1, D3, D5, D8, D9**,
with constraints that are now part of the plan (owner confirmation still
pending — they stay UNCONFIRMED in the PR body):

- D3: no dialog may lose REAL typed input on a one-press Escape — a draft or
  a note (DebugBundleNote, AgentTitle, McpServerDialog add, ThemeEditor,
  Conventions/CustomSkills editors, KeyVault add fields). Those either keep
  their state across close or confirm the discard. Filters are not "real
  input".
- D5: ⌘[ / ⌘] must not be taken inside Monaco or any code field (they are
  outdent/indent there); the section handler yields when the target is an
  editor or text field.
- D9: the lockfile for the new dependency is generated with npm 11
  `--package-lock-only`, diffed entry by entry, and `npm ci` is confirmed
  under BOTH npm 10.9 (Node 22.12) and npm 11 before pushing. Never a
  wholesale regen (#1195).
- D8: any confirm on a quit / beforeunload / window-close path stays native
  (or goes through main's dialog) — an async in-app dialog cannot block
  those paths.
- D10: B7 confirms X1 (#713 keyboard side) is this loop's.

## Design

### Keyboard model (K-rules — one model, every surface)

- **K1 Opening.** Focus lands inside the surface: first text input › the
  list (highlight on the current/first row) › the primary action for
  non-destructive dialogs › **Cancel for destructive dialogs** (Enter on open
  must never destroy). Done through Radix `onOpenAutoFocus` or `autoFocus`,
  never rAF-focus hacks where Radix can do it.
- **K2 Escape.** Radix `DialogContent` owns it: topmost surface only, focus
  restored to the opener. A surface with an open sub-popup takes the first
  Escape via `onEscapeKeyDown` + `preventDefault`. No feature adds a document
  Escape listener. Busy surfaces (BulkProviderSwitch mid-run, SetupGate
  must-answer) block Escape and **say so** in the footer legend.
- **K3 Enter.** Commits the one obvious action (DialogActions) or activates
  the highlighted row. `focusedControlOwnsEnter` always wins. Textarea
  dialogs commit with ⌘↵ (Enter is newline); the chip on the confirm reads
  `⌘↵` there. Shift+Enter is never commit.
- **K4 Tab.** input → list (one stop) → footer buttons, in visual order.
  List rows are not tab stops (`tabIndex={-1}` + `onMouseDown`
  preventDefault, per `focusedControlOwnsEnter`'s doc); the highlight is an
  index with `aria-activedescendant` on the focused input/list.
  **Focus-owner invariant (steering note k2):** `aria-activedescendant` goes
  ONLY on the element holding DOM focus — the filter input (as a combobox
  with `aria-controls`) for filterable lists, or the listbox itself
  (`tabIndex={0}`, focused in onOpenAutoFocus) for plain lists. Never on an
  unfocused listbox inside a focused DialogContent.
- **K5 Lists.** ↑/↓ move, Home/End jump, PgUp/PgDn move one visible page,
  ⌃N/⌃P alias ↑/↓, j/k only where the surface has no text input. Clamp at
  ends (D4). Highlighted row always scrolled into view (`block: 'nearest'`).
  Space toggles in multi-select lists. Hover moves the highlight; click =
  highlight + activate. Implemented once as `useListNavigation`.
- **K6 Accelerators.** No per-surface letter mnemonics (they collide with
  type-to-filter and cannot be learned across 50 surfaces). In-dialog
  sections cycle with ⌘[ / ⌘] (D5). App chords stay blocked under modals.
- **K7 No mouse-only affordance.** Every clickable is a `<button>` (or has a
  role, tabIndex and key handler where a button is impossible), has a
  visible focus ring, and icon-only buttons have `aria-label` + a `title`
  that includes the live chord when a command backs it.
- **K8 Focus visible.** One indicator (T4).

### Hint / label design (H-rules)

- **H1 `Kbd`** — `components/ui/kbd.tsx`, shadcn's name and shape (`Kbd`,
  `KbdGroup`). `<kbd>` element, `rounded-chip`, h-4, min-w-4, px-1,
  10px `font-code`, `border border-border bg-surface-hi text-muted`,
  `aria-hidden` when it duplicates an accessible label. Accepts a canonical
  `Keybinding` (`binding` prop → `displayKeybinding`) or literal glyph
  children. Variant `onAccent` for chips inside filled buttons.
- **H2 In-control chips.** `DialogActions` renders `⎋` on Cancel and `↵`
  (or `⌘↵` with `confirmChord="Mod+Enter"`) on confirm **only when that key
  actually does it** (confirmOnEnter / a list that commits on Enter). A chip
  that lies is worse than none.
- **H3 One legend.** Keys without a button go in `DialogActions`' new
  `legend` prop, rendered left of the buttons as `Kbd` + word pairs
  separated by `·`, 10px muted, one line, truncates rather than wraps.
  Never a separate legend row in the body.
- **H4 Live chords.** Any chord that names a command resolves through
  `resolveEffectiveKeybindings` + `displayKeybinding` (a small
  `useCommandChord(commandId)` hook), never a literal. Fixed interaction keys
  (↑↓, ↵, ⎋, Space) are literals because they are not rebindable.
- **H5 Copy.** Legend words are verbs, lowercase, one word where possible:
  `move`, `open`, `toggle`, `select`, `back`. Buttons keep command-style
  imperative Title Case. Cancel is always "Cancel"; close-only dialogs have
  one "Close" button (ghost) with `⎋`; no "Esc"/"close"/"✕" buttons.

### Token rules (T-rules)

- **T1 Radius** — semantic tiers only. Dialog/menu/popover `rounded-float`;
  buttons/inputs/option rows `rounded-control`; keycaps/badges
  `rounded-chip`; plates `rounded-slab`. Bare `rounded` / `rounded-[Npx]` on
  a floating or interactive element is converged to its tier.
- **T2 Widths** — `DialogContent size` presets (D7); max height
  `max-h-[86vh]` for scrolling dialogs. No `max-w-*` fighting the base.
- **T3 Anatomy** — `DialogHeader` px-4 py-3 (title 13px medium,
  description 11px muted); body `px-4 py-3` (`gap-3` between blocks); list
  bodies: container `py-1`, rows `px-4 py-1.5` — or, for a list inside a
  bordered `rounded-slab` well within a padded body, rows `px-3 py-1.5`;
  footer = `DialogActions`
  (px-4 py-3). No whole-content `p-5/p-6`. A body never relies on the
  header's padding for its own inset.
- **T4 Focus** — `:focus-visible` global outline uses `--theme-focus-ring`;
  controls use `focus-visible:ring-1 ring-focus-ring` (+
  `focus-visible:border-focus-ring` when bordered); inputs
  `focus-visible:border-input-border-focus`. `focus:border-accent` and 2px
  `outline-accent` converge. `outline-none` only with a replacement, or on a
  container that is focused programmatically as a key sink **and** shows its
  active row instead.
- **T5 Type** (dialogs, pickers, menus, settings) — title 13px, body 12px,
  secondary/meta 11px, legends/chips 10px. No `font-semibold` title
  overrides; `text-[15px]`/`[14px]`/`[11.5px]`/`[10.5px]`/`[9px]` converge.
- **T6 Font** — `font-code` only; `font-mono` removed.
- **T7 Rows** — hover `bg-row-hover-bg`; highlight `bg-row-selected-bg` with
  a 2px `border-l-accent`; hover moves the highlight so the two never show
  on different rows.
- **T8 Buttons** — every dialog/menu action is `<Button>`; raw `<button>`
  only for list rows and chips, which carry the T4 ring.

## Files (cross-cutting; per-surface files are in the Ledger)

- Create `components/ui/kbd.tsx` — `Kbd`, `KbdGroup` (H1).
- Modify `components/ui/dialog-actions.tsx` — chips on Cancel/confirm,
  `legend` prop, `confirmChord` (H2, H3).
- Modify `components/ui/dialog.tsx` — `size` variant (T2); close button
  converges on `Button ghost` + `Kbd ⎋`.
- Create `components/ui/confirm-dialog.tsx` — `ConfirmDialog` + a
  `useConfirm()` promise helper replacing `window.confirm` (D8).
- Create `components/ui/dropdown-menu.tsx` (D9) — Radix DropdownMenu, token
  styled, z above dialogs.
- Create `lib/useListNavigation.ts` — K5 in one place: `{ count, index,
  setIndex, onKeyDown, getRowProps(i) }`, options `{ loop, jk, pageSize,
  onActivate, onToggle }`.
- Create `features/command-keybindings/useCommandChord.ts` — H4.
- Modify `styles.css` — T4 global outline token, `.extension-loading-ring`
  tokens.

## Tests

Renderer tests (`*.renderer.test.tsx`, happy-dom, real components, real key
events via `fireEvent.keyDown` on the focused element). Each is written to
fail on the pre-change code, and the failure is recorded in Execution notes.

- `components/ui/kbd.renderer.test.tsx` — renders a canonical binding as its
  display glyphs; malformed binding renders as itself (no throw).
- `components/ui/dialog-actions.renderer.test.tsx` (extend) — `⎋` chip on
  Cancel, `↵` chip on confirm only when `confirmOnEnter`; `⌘↵` with
  `confirmChord`; legend renders; ⌘↵ commits from a textarea when
  `confirmChord="Mod+Enter"` and plain Enter does not.
- `lib/useListNavigation.renderer.test.tsx` — ↑/↓ clamp, Home/End,
  PgUp/PgDn, ⌃N/⌃P, j/k only when enabled, Enter activates, Space toggles,
  highlight follows hover, scrollIntoView called on move.
- Per surface (Ledger column "test"): the surface's specific keyboard gap,
  e.g. "Tab from the ColorFlag grid reaches Done; ←/→ move between swatches;
  Enter picks", "SkillMenu opens on Enter, ↓ moves, Escape closes and
  returns focus to ⋯". Visual changes are not unit-tested (they are class
  swaps; a test would restate the class) — they go to the owner checklist.
- `confirm-dialog` — Enter on open does not confirm a destructive confirm
  (focus on Cancel), ⌘↵/click confirms, Escape resolves false.

## Verification

- While iterating: the touched surfaces' renderer tests only
  (`npx vitest run --project renderer <paths>`).
- At the end: `npx tsc -b` (both projects, per memory — electron-vite and
  vitest do not type-check), `npm run check` (includes check:keybindings),
  full `npm test`, CI quality gate.
- **Verification boundary:** the app is never launched (owner rule). Focus
  order across portals, real scroll-into-view, native `<select>` behaviour,
  real macOS key glyph production and the actual look of chips/spacing are
  NOT proven here. They are listed per surface in the **Owner visual
  checklist** — that checklist is how the visual half is verified.

## Out of scope

- Feed/transcript typography and the tile grid (hard rule 1 already governs
  it); covered only where a keyboard gap exists (feed row picker ↑↓↵ is
  reserved and already works).
- Functional bugs found on the way → issues labelled `bug`, "found by
  keyboard loop" (B7 owns them).
- Phone/remote UI (separate CSS pass, #1187 area).
- Extension-contributed UI inside iframes (the host frame only).
- A vim mode (#117) — this builds the single key model it would hook into.

## Ledger

Status: `todo` / `wip` / `done <sha>`. "Keys today" is from the sweep;
"Fix" is the delta to the K/H/T rules. Every row gets an owner-checklist
entry when it lands.

### Foundations (land first — every surface row depends on them)

| # | Item | Status |
|---|---|---|
| F1 | `Kbd` primitive + test | done |
| F2 | `DialogActions` chips + `legend` + `confirmKey` + `escapeCancels` + tests | done |
| F3 | `useListNavigation` + test | done |
| F4 | `DialogContent size` presets + close button convergence | done (presets exist; call sites migrate in their S-rows) |
| F5 | Focus tokens: global outline → focus-ring; `.extension-loading-ring` tokens | done |
| F6 | `useCommandChord` + replace the ~16 hard-coded chord strings | done (fixed-key legends in PathPicker/AgentActivity/BulkSwitch move with their S-rows) |
| F7 | `ConfirmDialog` + replace `window.confirm` ×17 (destructive: focus Cancel, and never ⌘↩ — steering note 1; quit/close paths stay native — B7) | done (17/17 replaced; none was on a quit/close path) |
| F8 | `dropdown-menu` primitive (D9) | done |

### Dialogs (Radix)

| # | Surface (file) | Keys today | Fix | Status |
|---|---|---|---|---|
| S1 | CloseConfirmationDialog (`workspace/ui`) | default focus Cancel; no Enter; no hints | DialogActions (danger, focus Cancel, chips); body px-4 (flush today) | done |
| S2 | PinAgentsModal (`dispatch-pin`) | ↑↓ j/k Space Enter; bare `<kbd>` legend in body; p-5 | legend → DialogActions legend; useListNavigation; T3 anatomy + header | done |
| S3 | ReorderTabsModal | ↑↓, two-phase Enter; no hints; p-5, outline Cancel | legend (↑↓ move · ↵ pick/drop); DialogActions; T3 | done |
| S4 | AgentViewModePickerModal | ↑↓ Enter; no hints | useListNavigation; legend; chips | done |
| S5 | ProviderSwitchPickerModal | ↑↓ ⌃N/P Enter; prose hint; outline Cancel | useListNavigation; legend; ghost Cancel | done |
| S6 | NewAgentInDialog | ↑↓ ⌃N/P Enter ⌫ back; prose hint | useListNavigation; legend (⌫ back) | done |
| S7 | RewindToPromptModal | ↑↓ ⌃N/P Enter on scroller; no hints; outline-none | useListNavigation; legend; T4 | done |
| S8 | ViewPromptsModal | scroll only; outline-none scroller | Close ⎋; T4 focus on scroller | done |
| S9 | ColorFlagPickerModal | Tab only, no arrows on a grid | ←→↑↓ grid nav, Enter picks, legend; DialogActions | done |
| S10 | DispatchRowProjectModal | Tab only; px-2 py-2; `rounded`, `text-fg`, `bg-surface-raised` | useListNavigation; T1/T3 tokens | done |
| S11 | GridDispatchShapeOverlay | Enter in inputs; `rounded`, `rounded-[2px]`, `text-fg` | DialogActions chips; T1 tokens | done |
| S12 | AgentTitlePrompt | form submit | DialogActions chips; T3 | done |
| S13 | CloseOldAgentsModal | no Enter; "Esc" header button; raw buttons | DialogActions (danger); remove Esc button; T3/T8; `focus:border-accent` → T4 | todo |
| S14 | CloseCompletedAgentsModal | no Enter; raw header/footer | as S13 | todo |
| S15 | BulkProviderSwitchModal | "Esc" button gets focus; busy blocks Esc silently | DialogActions; busy legend; K1 focus | todo |
| S16 | RootManagementConfirmDialog | checkbox focus; no Enter | DialogActions (confirmDisabled until ack); chips | todo |
| S17 | MergeProjectTabsModal | select focus; no Enter; mx-4 mt-3 pieces | DialogActions; T3 body | todo |
| S18 | QueuedPromptDialog (`QueueStrip`) | showCloseButton; no footer; 2px outline-accent rows | Close ⎋; T4 rows | todo |
| S19 | DebugBundleNotePrompt | ⌘↵; "Skip" outline | DialogActions `confirmChord` ⌘↵ chip; Cancel label | todo |
| S20 | ConversationsPicker | ↑↓ Enter; "esc" label + prose | useListNavigation; legend; T4 input | todo |
| S21 | AgentActivityView | richest keys; legend row; pt-4, 15px title | legend → DialogActions/footer legend; D3; T3/T5 | todo |
| S22 | QuickOpenOverlay | ↑↓ Enter; sr-only hint; outline-none input | useListNavigation; legend; T4 | todo |
| S23 | ContentSearchOverlay | ↑↓ Enter; sr-only hint | as S22 | todo |
| S24 | ConfirmCloseDialog (editor) | autoFocus Save&Close | DialogActions-like 3-button footer with chips; K1 | todo |
| S25 | ConfirmDeleteDialog (editor) | autoFocus Cancel | DialogActions danger | todo |
| S26 | KeyboardShortcutsModal | search focus; no arrows; font-mono chips | Kbd chips; ↑↓ over results; Close ⎋ | todo |
| S27 | ThemeEditorModal (SettingsPage) | name autoFocus; secondary buttons | DialogActions; T3 | todo |
| S28 | AgentCodeConventionsEditorModal | window.confirm; raw buttons | ConfirmDialog; T8; ⌘↵ save chip | todo |
| S29 | AgentCodeCustomSkillsModal | as S28 | as S28 | todo |
| S30 | AgentMcpServersModal | no Enter; `max-w-xl` no-op | size preset; Close ⎋ | todo |
| S31 | McpServerDialog | textarea autoFocus; `max-w-2xl` no-op (renders 520) | size md; ⌘↵ confirm chip | todo |
| S32 | AddSkillDialog | Enter = find; square inputs/cards | T1 tokens; legend (↵ find); DialogActions | todo |
| S33 | ReportHistoryModal | no keys; outline Close | Close ⎋ ghost; scroller focus T4 | todo |
| S34 | UsageModal | ↑↓ rail; lowercase "close"; p-4 | D5 sections; Close ⎋; T3 | todo |
| S35 | AgentAnalyticsModal | "close" button; p-4 | as S34 | todo |
| S36 | KeyVaultModal | Enter in inputs; window.confirm; prose footer | ConfirmDialog; Close ⎋ | todo |
| S37 | RemotePanel | ✕ raw button gets focus | Close ⎋; T3 | todo |
| S38 | PerformanceMonitor | showCloseButton; p-4 sections | D5 sections; Close ⎋ | todo |
| S39 | SetupGate | px-5 py-4; raw buttons; blocked Esc | T3/T8; legend when Esc blocked | todo |
| S40 | DictationGuideModal | DialogActions Done | chips (automatic from F2); T3 | todo |
| S41 | WorkflowHistoryDialog | showCloseButton; p-3 | Close ⎋; T3 | todo |
| S42 | AppHostSurface | iframe focus | close chip only; iframe keys are the extension's | todo |
| S43 | CommandPalette | input ↑↓ Enter; sub-modes; px-3 py-2 header; raw sub-form buttons; plain-text chords | Kbd chords on rows; legend; T8 sub-form | todo |
| S44 | PathPickerModal | Tab/↑↓/⇧↵/two-phase Esc; p-6; lowercase prose + "cancel" | T3 anatomy; legend with Kbd; DialogActions | todo |
| S45 | SettingsPage | full-page takeover; sections | D5; T3; focus into section | todo |

### Hand-rolled overlays, menus, popovers

| # | Surface | Keys today | Fix | Status |
|---|---|---|---|---|
| M1 | AppearanceMenu (`feed`) | Escape only; focus never enters | dropdown-menu primitive | done |
| M2 | SkillMenu (`skills/ui/SkillsGrid`) | none; closes on mouseLeave | dropdown-menu primitive; ConfirmDialog | done |
| M3 | CommandSortControl | good (Esc/Tab/↑↓/Home/End/Enter) | visuals only (T1/T7) | todo |
| M4 | ExplorerPane context menu | good | visuals (T7) | todo |
| M5 | PathInput dropdown | good | visuals (T7) | todo |
| M6 | NewAgentPlacementOverlay | capture ↑↓ Enter Esc; focus never moved; footer px-3 | legend with Kbd; T3 footer | todo |
| M7 | TldrOverlay / GoalLoopPane | hold/latch; no focus | hint chips for release/dismiss | todo |
| M8 | GlobalToast / CaffeinateToast | click-only dismiss; caffeinate z-50 under scrim | keyboard dismiss path; layering note (functional part → issue) | todo |
| M9 | RenderingDebugInspector | prose "Press Esc" | Kbd | todo |
| M10 | Chart tooltips, PocketStrip hover | mouse-only | focusable data points only where a keyboard user loses information | todo |

### Pickers, lists, strips, settings (non-modal)

| # | Surface | Keys today | Fix | Status |
|---|---|---|---|---|
| N1 | TabBar (`workspace/tile-tree/TabBar.tsx`) | tab is `div onClick`, no role/tabIndex (L78); close ✕ hover-only, no aria-label | `tablist`/`tab` roving tabindex like EditorTabs (←→ Home End, Delete closes); ✕ revealed on focus-within + aria-label; title chord live (F6) | todo |
| N2 | DispatchAgentList (sessions sidebar) | rows are buttons in Tab order; no arrows in list; no `aria-current`; cap toggle/project button no focus style | ↑↓ within the focused list (moves selection like ⌥↑↓), `aria-current` on active row, T4 on header controls | todo |
| N3 | DispatchMiniList | buttons, hover ring only | T4 focus ring; `aria-current` | todo |
| N4 | TiledDispatch SplitHandles ×3 (L214/347/567) | mouse only, not focusable | `onKeyboardDelta` + `label` like GlobalEditorShell L1213 | todo |
| N5 | Spotlight strip + pocket radiogroup | no aria-pressed; radiogroup without arrows | aria-current/pressed; ←→ in radiogroup | todo |
| N6 | Reader strip | no aria-pressed | aria-current | todo |
| N7 | WorkflowViewSelector | tablist without roving/arrows | roving tabindex ←→ | todo |
| N8 | QueueStrip | good focus styles (2px outline-accent) | T4 converge only | todo |
| N9 | PathPicker Resume list | reuses ConversationRow with `selected={false}` — **unreachable by keyboard** | include in ↑↓ order after suggestions (or Tab into it) with useListNavigation | todo |
| N10 | CommandPalette rows | `div onClick`, no role; no combobox/activedescendant | `listbox`/`option` + activedescendant on input; Kbd for shortcut column (S43) | todo |
| N11 | ConversationsPicker splitter + PromptList | splitter mouse-only; `li role=listitem aria-selected` invalid; PromptList `rounded-slab` cards (violates "no cards") | keyboard splitter; valid roles; T7 rows | todo |
| N12 | Composer SlashCommandPicker | keys forwarded to agent; no activedescendant | activedescendant link only (keys stay the agent's) | todo |
| N13 | Feed scroller | not focusable; only End | focusable scroller when not in a text field? — keep reserved picker ↑↓↵; PgUp/PgDn/Home in `feed` context | todo |
| N14 | Settings sidebar/search/toggles/selects | no aria-current; toggles lack `role=switch`; selects lack radio semantics; sidebar hidden < md | `role=switch`/`aria-checked`; radiogroup + arrows; aria-current; D5 ⌘[ ⌘] | todo |
| N15 | Settings hotkey editors | capture works | Kbd chips (T6 font-mono → font-code) | todo |
| N16 | Provider option modals (Claude ResumePromptModal L121, Codex CodexApprovalModal L166) | `div onClick` rows | buttons/`option` rows with arrows, or confirm keys reach the agent — verify first | todo |
| N17 | GlobalToast / PaneToast | no `role=status`/`aria-live`; click-only dismiss | role=status; dismiss via Escape when focused / timeout unchanged | todo |
| N18 | SettingsBar | caff toggle no aria-pressed | aria-pressed; T4 | todo |
| N19 | Chart markers (TimeSeriesChart L184) | pointer shortcut by design | leave; note in checklist | todo |

Row-highlight variants to converge under T7 (from the sweep): `bg-row-selected-bg`
(palette, sort, conversations, PromptList, hotkey inputs, ThemePicker),
`bg-accent-soft` (QuickOpen, ContentSearch, PathInput, SlashPicker),
`bg-accent/12` (AgentViewMode, ProviderSwitch, NewAgentIn), `bg-accent/15`
(AgentActivity, WorkflowViewSelector), `bg-accent/10` (WorkflowHistory,
Bulk/CloseOld), solid `bg-accent` (placement overlay, ReorderTabs,
Spotlight/Reader strips — strips keep solid: they are selected *tabs*, not a
highlight), `bg-surface-hi` (PinAgents, Usage), settings `bg-control-active-bg`
(controls, keeps its own token). Popover chrome converges on
`bg-popover-bg border-popover-border` + `--theme-shadow-color` (today three
hard-coded rgba shadows and `shadow-lg`/`shadow-2xl`).

### Cross-cutting last

| # | Item | Status |
|---|---|---|
| X1 | #713 condition modal scoped to its pane (keyboard side; tell B7) | todo |
| X2 | `font-mono` → `font-code` sweep (T6) | todo |
| X3 | `focus:border-accent` / `outline-none` sweep (T4) | todo |
| X4 | Stale comments (`defaults.ts` dictation) | done |
| X5 | Undefined theme tokens (`text-fg`, `bg-surface-raised`) outside the S-rows — found in S10/S11 | todo |

## Owner visual checklist

What to eyeball per surface once built (the app is never launched here). One
line per landed row: open it, check the listed things, in Round, Soft and
Sharp corners and one light theme.

- **F1/F2 chips (any DialogActions dialog — Pin Agents, Dictation Guide
  today):** `Cancel ⎋` and `<Confirm> ↩` chips sit inside the buttons, the
  footer does not grow taller than before (chip h-4 inside an h-7 button),
  the chip on the filled confirm reads as part of the button (translucent
  frame on accent, not a dark sticker), and in Sharp corners the chip is
  square, in Round it is a capsule.
- **F4 corner close (Queued Prompt, Workflow History, Performance, extension
  app host):** the corner reads `× ⎋`, sits vertically centred on the header
  line (top-2.5, h-6), hover fills with the control hover colour, and Tab
  shows the ring (it used the plate radius before).
- **F5 focus + spinner:** in Settings → Appearance → Custom, set Focus Ring to
  a colour clearly different from the accent, then Tab through any dialog,
  the sidebar and the tab bar — EVERY focus indicator (outline and ring)
  shows the new colour. Open an extension app while it loads: the spinner
  ring is now visible (border-hi track, accent arc).
- **F6 live chords:** rebind New Tab, Save Editor File, Browser Pocket, Undo
  Close and Select Next Agent in Settings → Commands & Shortcuts, then check:
  the no-tabs Welcome button (`New Tab` + chip, accent button, title case),
  the tab bar `+` tooltip, the editor Save tooltip, the pocket strip
  "Browser" tooltip, the close toast ("… — <chord> Undo Close"), and the
  empty focused lane hint all show the NEW chord; unbinding one drops the
  chord cleanly (no empty parentheses).
- **F7 confirms (Skills grid ⋯/toggles, Conventions + Custom Skills editors
  incl. Escape on a dirty draft, Key Vault deletes, workflow resume):** the
  confirm appears ABOVE the dialog that asked, sm width, title + detail line,
  verb button (never "OK"); a destructive one opens with the focus ring on
  Cancel and the red button carries no ↩ chip; Escape closes only the
  confirm. Also check nothing behind it stalls while it is open (streaming
  feeds keep moving — native confirm used to freeze them).
- **M2 Skills ⋯ menu (Settings → Skills, a row's ⋯):** Tab to ⋯, Enter opens
  the menu with the first item highlighted; ↑↓ move, typing a letter jumps;
  Escape closes it and the ring is back on ⋯; moving the mouse off the menu
  no longer closes it; the menu paints above Settings, popover colours +
  theme shadow, items are rounded option rows with the row-highlight colour;
  a long "Reveal <path>" truncates inside max 360px.
- **M1 Appearance (status bar eye):** Tab to the eye (ring visible), Enter
  opens with focus on the first mode; ↓ walks the mode tiles row by row then
  the swatches then High Contrast; Enter/Space applies and the panel STAYS
  open (live preview); the highlighted swatch shows a thin focus-colour
  outline, the chosen one keeps its ink ring; section labels are 10px
  "MODE"/"ACCENT"; Escape closes and the ring returns to the eye; the panel
  uses popover colours + theme shadow instead of the old hard rgba.
- **S1 Close confirmation (close a working agent; Close Tab over several):**
  the target list and the "Undo Close restores…" note are inset 16px from
  the dialog edge (they ran flush before); width 440; focus ring on Cancel
  at open; `Cancel ⎋` + red `Close 2` with no chip; list rows 12px.
- **S2 Pin Sessions:** header bar + padded body + footer like every other
  dialog (no more p-5 card); footer left reads `↑ ↓ move  ␣ toggle  N pinned ·
  i/N` in 10–11px muted, right `Cancel ⎋` `Pin N Agents ↩`; highlight is the
  row-selected colour with a 2px accent bar (was surface-hi + 4px bar); the
  tab chip is a capsule at 10px; End/Home/PgDn move on a long list; the
  highlight scrolls into view and does not jump when the list scrolls under
  a still mouse.
- **S3 Reorder Tabs:** standard anatomy at 440 wide; footer legend reads
  `↑ ↓ select  ↩ pick up` while browsing and `↑ ↓ move tab  ⎋ put down` with
  a tab lifted; `Done` gains its ↩ chip only while a tab is lifted; the
  lifted row stays solid accent, the cursor row is row-selected + 2px bar;
  the per-row ↑/↓ buttons show an inset focus ring when tabbed to; a
  "Tabs changed…" error shows in red in the footer's left slot.
- **S4 Agent View Mode (⌥V):** list sits in a padded body (was mx-4 my-4);
  highlight = row-selected + 2px accent bar (was accent/12); labels 12px
  medium (not semibold); footer `↑ ↓ move` · `Cancel ⎋` · `Apply ↩` (new
  button; disabled when the highlighted mode is unavailable); the list gets
  a focus ring when tabbed back to.
- **S5 Switch Provider:** same picker pattern as S4 — padded body, T7 rows
  (py-2, 12px medium), footer `↑ ↓ move` · `Cancel ⎋` (ghost, was outline) ·
  `Switch ↩`; the old prose line "↑↓ choose · Enter switch · Esc cancel" is
  gone; width is the 520 default (was 500).
- **S6 New Agent In (⌘N-adjacent command):** agent step footer `↑ ↓ move` ·
  `Cancel ⎋` · `Next ↩`; project step adds `Back ⌫` and `Create ↩`; rows
  py-2, 12px medium, row-selected + 2px bar; a disabled project stays
  visible at half opacity and the highlight skips it; the list keeps its
  focus ring across the step change.
- **S7/S8 Rewind to Prompt / View Prompts (shared PromptList):** prompts are
  now FLAT divided rows inside one bordered well (were separate rounded
  cards with gaps — **owner call: confirm you prefer flat rows here**; the
  full prompt text still wraps); highlight = row-selected + 2px accent bar;
  Rewind: the "rewinds this pane…" sentence moved from the footer into the
  header description, footer `↑ ↓ move` · `Cancel ⎋` · `Rewind Here ↩`, the
  list takes focus once prompts load; View Prompts: one ghost `Close ⎋`
  (was outline), the scroller shows an inset ring when tabbed to; both 860
  wide (lg preset; were 760).
- **S9 Color Flag:** opens with the focus outline on the CURRENT colour;
  the set colour has an ink ring and the focused one a focus-colour outline
  (they were the same ring before — check both are visible at once when
  they differ); ←/→ walk and wrap, Home/End jump, Enter picks and closes;
  footer `← → move  ↩ pick` · `Clear Flag` · `Close ⎋` (was outline "Clear
  flag" + filled "Done"); 440 wide.
- **S10 Row Projects (Dispatch row header → projects):** projects sit in a
  bordered well in a padded body (was edge-to-edge px-2); hover now actually
  shows (the old `bg-surface-raised`/`text-fg` tokens did not exist);
  checked = accent text + ✓; highlight = row-selected + 2px bar; description
  at 11px (was 10px); footer `↑ ↓ move  ␣ toggle` · `Any Project` ·
  `Close ⎋` (was ghost "Any project" + filled "Done"); title "Row Projects".
- **S11 Grid Dispatch (⌘D):** 440 wide in Simple, 640 in Advanced (were
  400/560); Simple/Advanced, the row ×, project chips and Show all/Cap all
  show a focus ring when tabbed and a working hover (the `text-fg` token did
  not exist); the lane preview squares are square (was a 2px radius);
  Advanced row boxes use the plate radius; description 11px; footer
  `Cancel ⎋` · `Apply ↩`; "+ Add Row".
- **S12 Set Title:** footer is `Clear Title` at the far left (ghost), then
  `Cancel ⎋` (ghost, was outline) and `Save ↩`; body py-3 (was py-4); hint
  line 11px; typing then Enter saves.

## Tasks

- [ ] 1. Plan committed, draft PR open, B7 told — hands the ledger to task 2.
- [ ] 2. Foundations F1–F8 — produce `Kbd`, `DialogActions{legend,confirmChord}`,
      `useListNavigation`, `DialogContent size`, `useCommandChord`,
      `ConfirmDialog/useConfirm`, `DropdownMenu*`; verified by their tests.
- [ ] 3. Dialog rows S1–S45, one commit per surface (or tight family), each
      updating the ledger + owner checklist.
- [ ] 4. Menu/overlay rows M1–M10.
- [ ] 5. Non-modal pickers/lists/strips/settings rows.
- [ ] 6. Cross-cutting X1–X4.
- [ ] 7. Plan-vs-built, full checks, review round (2 Codex + 1 Pi, own
      detached worktrees), at most one verification round. Leave the PR
      open, green, reviewed.

## Rulings

- Ruling: Enter's glyph is `↩` (what `displayKeybinding` already emits), not
  `↵` as the first draft of H2 wrote — one display projection beats a
  prettier glyph — cost if wrong: one table entry in `@shared/keybindings`.
- Ruling: `confirmChord` became `confirmKey: 'Enter' | 'Cmd+Enter' | null`,
  and `confirmOnEnter={false}` now means "the surface wires the key" (chip
  still shown) rather than "no key commits" — the only consumer (Pin Agents)
  commits on Enter through its own hook, so the chip is true there — cost if
  wrong: a future dialog that wants no key commit must pass
  `confirmKey={null}`, documented on the prop.
- Ruling: ⌘↩ commits from anywhere in the dialog, including a focused
  textarea or button — the modifier is an explicit commit — cost if wrong:
  ⌘↩ on a focused Cancel commits; judged correct (the user asked to commit).

- Ruling: chords typed into command DESCRIPTIONS (`**Shortcut:** ⌘⇧E.`) are
  deleted, not resolved — the palette's detail pane already shows the live
  `command.shortcut` right above the description, so the prose line was a
  stale duplicate. Fixed, non-rebindable grammar in prose (⌘1–9, ⌘N row
  numbers) stays literal; rebindable chords in static prose (settings
  descriptions, the agent control reference) are replaced by the command's
  name — cost if wrong: slightly less discoverable settings copy.
- Ruling: hidden duplicate commands' notes ("kept runnable for the ⌥⇧T
  chord") keep their chord — it records WHY the command exists, not a hint.

- Ruling: `@radix-ui/react-dropdown-menu` pinned EXACT at 2.1.20 — the
  release on react-dialog 1.1.19's train (same dismissable-layer 1.1.15,
  focus-scope 1.1.12, portal 1.1.13, primitive 2.1.7). Latest (2.1.24) would
  add second copies of the layer/focus stacks, breaking Escape arbitration
  for a menu inside a dialog — cost if wrong: a later bump must move dialog
  and dropdown-menu together (recorded in dropdown-menu.tsx's header).
- Ruling: AppearanceMenu (a panel of mode buttons, swatches and a toggle) is
  built on DropdownMenu radio/checkbox items rather than a separate Popover
  dependency; arrows traverse the grid in DOM order and typeahead works on
  labels — cost if wrong: ↑↓ across a 2-column grid feels linear; a Popover
  primitive would be a second new dependency.

## Execution notes

- Sweep counts: 44 Radix dialogs (45 mounts), 15 hand-rolled overlays/menus,
  17 `window.confirm`, 27 independent arrow implementations, 5 use
  activedescendant, 2 roving tabindex, 14 clickable-only action sites, 3
  unfocusable splitters, 7 row-highlight variants, 4 popover shadow variants.
- 2026-09-25: read BRIEF, command-style, command-keybindings, useKeybinds
  header, styles.css tokens, ui primitives; three read-only sweeps
  (keybindings/tokens, dialogs, pickers/lists). Plan drafted.
- 2026-09-25 F1+F2: `components/ui/kbd.tsx` (Kbd, KbdGroup, KbdLegend),
  DialogActions chips/legend/confirmKey/escapeCancels. Confirm-red observed:
  3 of 5 new DialogActions tests fail on the pre-change file (chip labels,
  confirmKey null, ⌘↩ commit); the other 2 are guards (no Escape chip when
  blocked, plain Enter in a textarea is a newline).
- 2026-09-25 F3: `lib/useListNavigation.ts` + 13 renderer tests. New module,
  so no pre-change red; instead three mutations were each caught by one test
  (loop default on; Home/End taken from a text field; hover scrolling).
- 2026-09-25 F4 `4fae4900`, F5 `264a816d`. Steering reviewer (session
  d98f3f4b) note 1: an earlier `commit -a` had moved three submodule
  pointers; restored to main in a chore commit. From now on paths are staged
  explicitly, never `-a`.
- 2026-09-25 S12: Set Title drops its <form> (DialogActions' buttons have
  no type and would submit) for DialogActions' scoped Enter. Confirm-red:
  the new Enter/chips test fails on the pre-change file; "Clear title" →
  "Clear Title" (test lookup updated).
- 2026-09-25 S11: Grid Dispatch footer on DialogActions (Enter still
  applies only from number fields — chip shown, listener not wired), mode
  switch aria-pressed, nested-agents radiogroup, focus rings, tokens.
  Confirm-red: both new tests fail on the pre-change file.
- 2026-09-25 S10: Row Projects → multiselect listbox on useListNavigation
  (keyed by tab id; Space/Enter toggle live), undefined tokens replaced,
  close-only footer + Any Project. Confirm-red: both new tests fail on the
  pre-change file.
- 2026-09-25 S9: Color Flag swatches → radiogroup with roving tabindex
  (arrows linear + wrap, Home/End); current vs focus visually distinct;
  close-only footer + Clear Flag. Ruling: roving focus (not
  activedescendant) because each swatch is an independently activatable
  button and there is no commit key — the EditorTabs pattern. Confirm-red:
  3 tests fail on the pre-change file (one is the updated radio-semantics
  assertion).
- 2026-09-25 S7/S8: PromptList has read-only (list/listitem) and
  interactive (listbox/option + aria-activedescendant, focus owner) modes;
  flat rows. Rewind on useListNavigation with an effect that moves focus to
  the listbox after the async load (only if focus is still on the
  scroller). DialogActions confirm is now optional (close-only viewers).
  Confirm-red: Rewind focus/End test and View Prompts Tab-stop/Close test
  fail on the pre-change files. Copy: "Rewind here" → "Rewind Here".
- 2026-09-25 S6: New Agent In on two useListNavigation instances; the hook
  gained `keys` (highlight follows the ITEM in live lists — the dialog's
  documented tab-id invariant) and DialogActions gained `extraActions` for
  Back ⌫. Existing 13 tests unchanged and green. Confirm-red: focus/chips
  test fails on the pre-change file; the live-list test passes there (the
  old code tracked by id) and FAILS when `keys` is removed — the first
  version of that test highlighted the last row, where clamping lands on the
  same project, and did not catch the mutation; rewritten to highlight a
  middle row.
- 2026-09-25 S5: Switch Provider on useListNavigation (⌃N/⌃P kept via the
  hook), listbox focus owner with role=option rows, Switch button.
  Confirm-red: both new tests fail on the pre-change file.
- 2026-09-25 S4: Agent View Mode on useListNavigation (isDisabled skips,
  opens on the current mode), listbox focus owner, Apply button for Enter.
  Pattern for pick-one pickers: `↑↓ move` legend + Cancel ⎋ + <Verb> ↩.
  Confirm-red: 3/3 new tests fail on the pre-change file.
- 2026-09-25 steering note k2 (valid, both points): S2/S3 focused the
  dialog surface while aria-activedescendant sat on the unfocused listbox,
  and S2's onClick override dropped the highlight move. Fixed: listbox is
  the focus owner (tabIndex 0, focused on open, focus ring), invariant
  recorded in useListNavigation's header + K4; new `onItemClick` hook option
  replaces overriding onClick. Confirm-red: the two new Pin tests (focus on
  listbox across arrows; tap moves highlight + toggles) fail on the pre-fix
  files. Two focusedCancelEnter tests that pinned "focus = dialog" now pin
  the stricter "focus = listbox".
- 2026-09-25 S3: Reorder Tabs keeps its two-phase handler (a list hook
  would not model pick/move), gains Home/End in both phases, phase-aware
  legend and Done chip, standard anatomy. Confirm-red: all 3 new tests fail
  on the pre-change file.
- 2026-09-25 S2: usePinAgentsKeybinds composes useListNavigation (keeps
  its selection draft + Enter-commits-draft); modal on header/body/
  DialogActions with legend + counter in the footer. Confirm-red: End/Home/
  PageDown and footer-legend tests fail on the pre-change files; j/k+Space
  test is a guard. #867 focusedCancelEnter suite still green.
- 2026-09-25 S1: CloseConfirmationDialog on DialogActions (danger,
  confirmKey null) + `focusDialogActionOnOpen` helper extracted into
  dialog-actions (ConfirmDialog migrated onto it). Confirm-red observed for
  the new focus/chip test on the pre-change dialog. The "exactly two
  answers" test now compares accessible names (chips are aria-hidden
  decoration).
- 2026-09-25 M1: AppearanceMenu on DropdownMenu radio/checkbox items (menu
  stays open on select). Confirm-red observed: all 3 tests fail on the
  pre-change component.
- 2026-09-25 M2: SkillMenu on DropdownMenu. Confirm-red observed: both
  keyboard tests (Enter opens + Enter selects; Escape returns focus) fail on
  the pre-change component. The existing Hide test now drives the keyboard
  path instead of `click` (Radix opens on pointerdown/keys, not click).
- 2026-09-25 F8: `components/ui/dropdown-menu.tsx`, dep pinned 2.1.20.
  Lockfile per B7's procedure: generated with npm 11.8
  `install --package-lock-only --save-exact`; entry diff = 15 added
  top-level packages (4 @floating-ui, 11 @radix-ui), 0 removed, 0 changed
  except the root dependency list; `npm ci --dry-run` AND a real
  `npm ci --ignore-scripts --include=dev` pass under npm 10.9.0 (Node
  22.12.0) and npm 11.11.0 (Node 24.14.1), with no nested @radix-ui copies.
  The 15 package dirs were copied additively into the shared main
  node_modules for local tests (nothing existing touched).
- 2026-09-25 F7: `components/ui/confirm-dialog.tsx` (ConfirmDialog,
  requestConfirm, ConfirmHost registered last in modalSurfaces); all 17
  `window.confirm` sites migrated, dirty-draft close guards made async (B7's
  D3 condition: Escape on a dirty editor asks instead of discarding). New
  module; confirm-red by mutation: forcing `confirmKey='Enter'` for danger
  fails the "never commits on dialog-level Enter/⌘↩" test.
- 2026-09-25 F6: `features/command-keybindings/useCommandChord.ts`; 9 sites
  resolved live or reworded. Confirm-red observed: WelcomeEmpty test fails
  on the pre-change component. Existing close-toast tests (default ⌘⇧T) stay
  green as the default-path regression.
