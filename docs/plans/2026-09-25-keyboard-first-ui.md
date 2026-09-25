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
   two wrapping LISTS (PathInput, placement) change to clamp; the Usage rail
   turned out to be a vertical TABLIST (it switches the detail pane) and
   keeps wrapping, as tabs do; lane ⌥↑↓ is a workspace grammar, not a list,
   and keeps wrapping.
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
| S13 | CloseOldAgentsModal | no Enter; "Esc" header button; raw buttons | DialogActions (danger); remove Esc button; T3/T8; `focus:border-accent` → T4 | done |
| S14 | CloseCompletedAgentsModal | no Enter; raw header/footer | as S13 | done |
| S15 | BulkProviderSwitchModal | "Esc" button gets focus; busy blocks Esc silently | DialogActions; busy legend; K1 focus | done |
| S16 | RootManagementConfirmDialog | checkbox focus; no Enter | DialogActions (confirmDisabled until ack); chips | done |
| S17 | MergeProjectTabsModal | select focus; no Enter; mx-4 mt-3 pieces | DialogActions; T3 body | done |
| S18 | QueuedPromptDialog (`QueueStrip`) | showCloseButton; no footer; 2px outline-accent rows | Close ⎋; T4 rows | done |
| S19 | DebugBundleNotePrompt | ⌘↵; "Skip" outline | DialogActions `confirmChord` ⌘↵ chip; Cancel label | done |
| S20 | ConversationsPicker | ↑↓ Enter; "esc" label + prose | useListNavigation; legend; T4 input | done |
| S21 | AgentActivityView | richest keys; legend row; pt-4, 15px title | legend → DialogActions/footer legend; D3; T3/T5 | done (D3 exception kept: Esc clears the filter first) |
| S22 | QuickOpenOverlay | ↑↓ Enter; sr-only hint; outline-none input | useListNavigation; legend; T4 | done |
| S23 | ContentSearchOverlay | ↑↓ Enter; sr-only hint | as S22 | done |
| S24 | ConfirmCloseDialog (editor) | autoFocus Save&Close | DialogActions-like 3-button footer with chips; K1 | done |
| S25 | ConfirmDeleteDialog (editor) | autoFocus Cancel | DialogActions danger | done |
| S26 | KeyboardShortcutsModal | search focus; no arrows; font-mono chips | Kbd chips; ↑↓ over results; Close ⎋ | done |
| S27 | ThemeEditorModal (SettingsPage) | name autoFocus; secondary buttons | DialogActions; T3 | done |
| S28 | AgentCodeConventionsEditorModal | window.confirm; raw buttons | ConfirmDialog; T8; ⌘↵ save chip | done |
| S29 | AgentCodeCustomSkillsModal | as S28 | as S28 | done |
| S30 | AgentMcpServersModal | no Enter; `max-w-xl` no-op | size preset; Close ⎋ | done |
| S31 | McpServerDialog | textarea autoFocus; `max-w-2xl` no-op (renders 520) | size md; ⌘↵ confirm chip | done |
| S32 | AddSkillDialog | Enter = find; square inputs/cards | T1 tokens; legend (↵ find); DialogActions | done |
| S33 | ReportHistoryModal | no keys; outline Close | Close ⎋ ghost; scroller focus T4 | done |
| S34 | UsageModal | ↑↓ rail; lowercase "close"; p-4 | D5 sections; Close ⎋; T3 | done |
| S35 | AgentAnalyticsModal | "close" button; p-4 | as S34 | done |
| S36 | KeyVaultModal | Enter in inputs; window.confirm; prose footer | ConfirmDialog; Close ⎋ | done |
| S37 | RemotePanel | ✕ raw button gets focus | Close ⎋; T3 | done |
| S38 | PerformanceMonitor | showCloseButton; p-4 sections | D5 sections; Close ⎋ | done |
| S39 | SetupGate | px-5 py-4; raw buttons; blocked Esc | T3/T8; legend when Esc blocked | done |
| S40 | DictationGuideModal | DialogActions Done | chips (automatic from F2); T3 | done |
| S41 | WorkflowHistoryDialog | showCloseButton; p-3 | Close ⎋; T3 | done |
| S42 | AppHostSurface | iframe focus | close chip only; iframe keys are the extension's | done (no change: F4 corner close covers it) |
| S43 | CommandPalette | input ↑↓ Enter; sub-modes; px-3 py-2 header; raw sub-form buttons; plain-text chords | Kbd chords on rows; legend; T8 sub-form | done |
| S44 | PathPickerModal | Tab/↑↓/⇧↵/two-phase Esc; p-6; lowercase prose + "cancel" | T3 anatomy; legend with Kbd; DialogActions | done |
| S45 | SettingsPage | full-page takeover; sections | D5; T3; focus into section | done |

### Hand-rolled overlays, menus, popovers

| # | Surface | Keys today | Fix | Status |
|---|---|---|---|---|
| M1 | AppearanceMenu (`feed`) | Escape only; focus never enters | dropdown-menu primitive | done |
| M2 | SkillMenu (`skills/ui/SkillsGrid`) | none; closes on mouseLeave | dropdown-menu primitive; ConfirmDialog | done |
| M3 | CommandSortControl | good (Esc/Tab/↑↓/Home/End/Enter) | visuals only (T1/T7) | done (no change: already on popover tokens + row-selected) |
| M4 | ExplorerPane context menu | good | visuals (T7) | done |
| M5 | PathInput dropdown | good | visuals (T7) | done (+ combobox ARIA) |
| M6 | NewAgentPlacementOverlay | capture ↑↓ Enter Esc; focus never moved; footer px-3 | legend with Kbd; T3 footer | done |
| M7 | TldrOverlay / GoalLoopPane | hold/latch; no focus | hint chips for release/dismiss | done (goal loop; TLDR peek has no controls) |
| M8 | GlobalToast / CaffeinateToast | click-only dismiss; caffeinate z-50 under scrim | keyboard dismiss path; layering note (functional part → issue) | done (global + pane toasts; caffeinate layering → issue) |
| M9 | RenderingDebugInspector | prose "Press Esc" | Kbd | done |
| M10 | Chart tooltips, PocketStrip hover | mouse-only | focusable data points only where a keyboard user loses information | done (no change — see ruling) |

### Pickers, lists, strips, settings (non-modal)

| # | Surface | Keys today | Fix | Status |
|---|---|---|---|---|
| N1 | TabBar (`workspace/tile-tree/TabBar.tsx`) | tab is `div onClick`, no role/tabIndex (L78); close ✕ hover-only, no aria-label | `tablist`/`tab` roving tabindex like EditorTabs (←→ Home End, Delete closes); ✕ revealed on focus-within + aria-label; title chord live (F6) | done |
| N2 | DispatchAgentList (sessions sidebar) | rows are buttons in Tab order; no arrows in list; no `aria-current`; cap toggle/project button no focus style | ↑↓ within the focused list (moves selection like ⌥↑↓), `aria-current` on active row, T4 on header controls | done (↑↓ move focus, not selection — see ruling) |
| N3 | DispatchMiniList | buttons, hover ring only | T4 focus ring; `aria-current` | done |
| N4 | TiledDispatch SplitHandles ×3 (L214/347/567) | mouse only, not focusable | `onKeyboardDelta` + `label` like GlobalEditorShell L1213 | done (2% step, shared clamp with drag) |
| N5 | Spotlight strip + pocket radiogroup | no aria-pressed; radiogroup without arrows | aria-current/pressed; ←→ in radiogroup | done (pills `aria-current`; layout radios roving + shared `radioGroupKeyDown`; also swept into Grid Dispatch nested agents, Settings, Color flag) |
| N6 | Reader strip | no aria-pressed | aria-current | done (+ Older/Newer said ↑/↓ but only ⌥↑/⌥↓ acted → one binding drives chip + listener) |
| N7 | WorkflowViewSelector | tablist without roving/arrows | roving tabindex ←→ | done (vertical → ↑↓/Home/End, automatic activation, wrap; Show all moved out of the tablist) |
| N8 | QueueStrip | good focus styles (2px outline-accent) | T4 converge only | done (+ same 2px accent outline in the dictation input select and both workflow rows) |
| N9 | PathPicker Resume list | reuses ConversationRow with `selected={false}` — **unreachable by keyboard** | include in ↑↓ order after suggestions (or Tab into it) with useListNavigation | done (Tab stop + shared list keys) |
| N10 | CommandPalette rows | `div onClick`, no role; no combobox/activedescendant | `listbox`/`option` + activedescendant on input; Kbd for shortcut column (S43) | done (in S43) |
| N11 | ConversationsPicker splitter + PromptList | splitter mouse-only; `li role=listitem aria-selected` invalid; PromptList `rounded-slab` cards (violates "no cards") | keyboard splitter; valid roles; T7 rows | done (splitter in S20, PromptList roles/rows in S7) |
| N12 | Composer SlashCommandPicker | keys forwarded to agent; no activedescendant | activedescendant link only (keys stay the agent's) | done (textarea carries aria-controls/activedescendant/autocomplete while open; T7 row + popover tokens) |
| N13 | Feed scroller | not focusable; only End | focusable scroller when not in a text field? — keep reserved picker ↑↓↵; PgUp/PgDn/Home in `feed` context | todo |
| N14 | Settings sidebar/search/toggles/selects | no aria-current; toggles lack `role=switch`; selects lack radio semantics; sidebar hidden < md | `role=switch`/`aria-checked`; radiogroup + arrows; aria-current; D5 ⌘[ ⌘] | done (in S45) |
| N15 | Settings hotkey editors | capture works | Kbd chips (T6 font-mono → font-code) | todo |
| N16 | Provider option modals (Claude ResumePromptModal L121, Codex CodexApprovalModal L166) | `div onClick` rows | buttons/`option` rows with arrows, or confirm keys reach the agent — verify first | todo |
| N17 | GlobalToast / PaneToast | no `role=status`/`aria-live`; click-only dismiss | role=status; dismiss via Escape when focused / timeout unchanged | done (in M8) |
| N18 | SettingsBar | caff toggle no aria-pressed | aria-pressed; T4 | done (+ accessible name; T4 ring on caff + performance) |
| N19 | Chart markers (TimeSeriesChart L184) | pointer shortcut by design | leave; note in checklist | done (no change — see ruling) |

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
| X3 | `focus:border-accent` / `outline-none` sweep (T4) | done (4 `focus:border-accent` inputs → control focus form; Apps settings raw controls → Button/Input; exemptions recorded in Execution notes) |
| X4 | Stale comments (`defaults.ts` dictation) | done |
| X5 | Undefined theme tokens (`text-fg`, `bg-surface-raised`) outside the S-rows — found in S10/S11 | done (N2/N3) |

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
- **S13–S15 Close Old Agents / Close Completed / Bulk Provider Switch:** no
  "Esc" button beside the title any more; standard header bar; filter
  inputs/selects use the input colours and show the focus ring only on
  keyboard focus (was accent border on any focus); All/Clear are ghost xs
  buttons in title case; scope toggles announce pressed state and show a
  ring; footer = `Cancel ⎋` + filled red `Close N Agents` / filled accent
  `Switch N…` with NO ↩ chip (deliberate: bulk actions are Tab-then-Enter or
  click); Close Old's exclusion note moved into the header description;
  Bulk's mid-turn/terminals note is its own line above the footer, and
  while a batch runs Cancel is disabled, the ⎋ chip disappears and the
  footer says "Working — closing is paused…". The SAME in-flight rule now
  holds for Close Old and Close Completed (steering note k3): while their
  close batch runs, Cancel is disabled, its ⎋ chip is gone, and Escape /
  outside clicks do nothing until the batch settles. All 860 wide (lg).
- **S16 Root Agent Code Management confirm:** focus opens on the
  acknowledgement checkbox (Space ticks); footer `Cancel ⎋` (ghost, was
  outline) + red `Enable for This Agent` with no ↩ chip, disabled until
  ticked; width 520 (the `max-w-lg` override is gone).
- **S17 Merge Project Tabs:** one padded body (Keep select, "Merge into it"
  list) instead of separately-inset pieces; the select uses input colours
  with a keyboard focus ring; row hover uses the row-hover colour; the
  "N tabs, M agents move to …" status sits in the footer's left slot;
  `Cancel ⎋` (ghost, was outline) · `Merge ↩`; 640 wide (md, was 560);
  title no longer semibold.
- **S18 Queued Prompt (click a queued row):** opens with the prompt TEXT
  focused (inset ring on Tab), so ↑↓/PgDn scroll at once; corner `× ⎋`;
  title "Queued Prompt"; 860 wide. (The strip rows' 2px outline stays until
  N8.)
- **S19 Debug bundle / recording note:** `Skip ⎋` (ghost, was outline) ·
  `Save Note ⌘↩`; plain Enter is a newline; with text typed, Skip or Escape
  first asks "Discard this note?" (red Discard Note, focus on Cancel); body
  py-3; 640 wide.
- **S20 Conversations (⌘⇧R / Search Conversations…):** header shows a `⎋`
  chip where the lowercase "esc" was; the filter row ends with `↑ ↓ move  ↩
  resume` chips instead of "· ↑↓ ↵ resume"; scope/provider chips show a focus
  ring when tabbed (provider/children chips now control radius); Search
  opens in the box, Resume on the list (ring on the list when tabbed back
  to); the list/preview divider takes focus (turns the focus colour) and
  ←/→ resize it; 1240 wide (xl).
- **S21 Agent Activity:** header py-3 with a 13px title (was pt-4 + 15px);
  filter uses input colours + keyboard ring; highlighted row uses the row
  highlight (was accent/15); footer: chip legend `↑ ↓ move  ↩ open  ␣ select
  ⌘A all  ⌫ close` (truncates on a narrow window — check it reads at 960px),
  a red-outline `Close N Selected ⌫` when rows are ticked, and a ghost
  `Close ⎋` for the view; Home/End/PgUp/PgDn move. **Owner call:** Escape
  in the filter still clears it first (a recorded exception to D3 because
  type-to-filter can put text there by accident) — say if you want one-press
  close here too.
- **S22/S23 Quick Open (⌘P) / Search in Files (⌘⇧F):** a thin bottom strip
  now shows `↑ ↓ move  ↩ open  ⎋ close` (Quick Open) / the status line ends
  with `↑ ↓ move  ↩ open` (Search); the highlighted row uses the row
  highlight + a 2px accent bar (was accent-soft); ⌃N/⌃P and PgUp/PgDn move;
  Home/End still move the caret; the Aa match-case toggle shows a focus
  ring; Quick Open is 520 wide (default), Search 640 (md). The search inputs
  keep their borderless look with the caret as the focus signal (T4
  exception, as the palette).
- **S24 Editor "Unsaved changes" on tab close:** `Discard` moved to the far
  left as a red-OUTLINE button (was a second filled button beside Save);
  `Cancel ⎋` ghost; `Save & Close ↩` filled and focused on open; while
  saving everything disables, the ⎋ chip hides and Escape waits; 440 wide.
- **S25 Editor "Delete from disk?":** opens with the ring on `Cancel ⎋`; red
  `Delete` / `Delete & Discard` has no ↩ chip; the dirty-file list is 11px
  in a py-3 body (was 10px pb-3); 440 wide.
- **S26 Keyboard Shortcuts (⌘⇧/):** chords are the standard chips (same
  look as every button hint; were font-mono pills); rows are flat with a
  faint divider (were bordered rounded plates); 12px rows; search is the
  standard input (ring only on keyboard focus); ↓ from search moves into
  the list (inset ring) where ↑↓ scroll, PgUp/PgDn page from the search box;
  footer `Close ⎋`; 860 wide (was 720).
- **S27 Theme editor (Settings → Appearance → New/Edit theme):** standard
  surface and header (was popover background + panel-header bars); the
  header keeps only a ghost `Show Schema` toggle (its "Close" is gone);
  footer `Cancel ⎋` · `Save a Copy` (edit only) · `Save & Apply ⌘↩`, save
  errors in red at the left; editing then pressing Escape asks "Discard
  theme changes?"; body py-3.
- **S28/S29 Conventions editor / Custom Skills (Settings → Agents):** the
  small grey buttons (Insert Starter, Preview, Back to editor, Reload
  latest, Copy draft, row actions) are now the standard outline buttons with
  a focus ring; footer: red-outline Clear at the far left, `Cancel ⎋` /
  `Close ⎋`, filled `Save Changes ⌘↩` / `Save & Enable ⌘↩` / `Save Draft ⌘↩`
  (was a custom "control-active" filled button); while saving the custom
  skills Close disables and loses ⎋. Warning/danger-bordered status buttons
  are unchanged.
- **S30 Agent MCP Servers (session menu → MCP):** 640 wide (the old
  `max-w-xl` did nothing, so it was 520); body py-3; "built-in" tags 10px;
  footer: ghost `Reset to MCP Settings`, pending-state text on the left,
  `Cancel ⎋` (ghost, was outline), `Apply & Reload Agent` with NO ↩ chip
  (it restarts the agent — Tab or click).
- **S31 Add / Edit MCP server:** 640 wide (was stuck at 520); `Add Server ⌘↩`
  / `Save ⌘↩`; Delete… stays two-step at the far left; pasting a config and
  pressing Escape asks "Discard this MCP server config?" — also when ONLY a
  secret field was changed (typing into a secret and emptying it again is
  not a change); while a save runs, Cancel disables, loses ⎋, and Escape /
  outside clicks wait (same in the Conventions editor).
- **S32 Add Skills:** the source and filter fields are the standard inputs
  (were square with no focus styling); `Find Skills ↩` (Enter in the source
  field runs it); repo/notice/candidate boxes have the plate radius and
  candidates a hover; footer `Cancel ⎋` + `Install N Skills` with no chip;
  while finding/installing, Cancel disables and Escape waits; 860 wide.
- **S33 TLDR / Goal History:** opens with the history focused (inset ring on
  Tab) so ↑↓/PgDn scroll at once; footer one ghost `Close ⎋` (was outline).
- **S41 Workflow History:** body inset px-4 (was p-3); "Show 50 More" is the
  standard outline button; corner `× ⎋` (this dialog has no footer — the
  rule: a corner close only where no footer exists).
- **S34 Usage (⌘⇧U):** the header's lowercase "refresh"/"close" became a
  ghost `Refresh` and the corner `× ⎋`; the provider rail is one Tab stop —
  ↑↓ move the focus ring AND the selection together, Home/End jump — and
  ⌘[ / ⌘] switch provider from anywhere; rail entries use the control radius
  (were pill-shaped at Round corners) and the row-highlight colours; body
  py-3; title not semibold; 860 wide.
- **S35 Agent Analytics:** corner `× ⎋` replaces the lowercase "close"; ⌘[
  / ⌘] step the time range (Today / 7 days / 30 days …) from anywhere;
  project rows show a hover and an inset focus ring; body py-3; 1240 wide
  (xl, was 1040) — check the chart still reads well at the wider size.
- **S36 API Key Vault:** provider list is one Tab stop (↑↓ move + select,
  control radius, row-highlight colours — were pills on the canvas colour);
  every field is the standard input (were pills); the row actions (Reveal,
  Copy, Insert, Edit, Delete, Rename) are small ghost/outline buttons with
  focus rings (were bare text); the key form's `Save ↩` saves on Enter; with
  a key half-typed, Escape, switching provider (arrow or click), opening
  another key's Edit or "+ New Key" all ask "Discard this key?" (focus on
  Cancel) — an untouched Edit form never asks; the long note sits
  above a footer that is now just `Close ⎋`; 860 wide.
- **S37 Remote Control:** standard header with the corner `× ⎋` (was a bare
  ✕ with no focus ring that took focus on open); Enable/Disable and Show QR
  are outline buttons; LAN/Tunnel shows the ON half in the "active control"
  colours and announces it; Revoke is the red-outline button; 440 wide.
- **S38 Performance Monitor:** ⌘[ / ⌘] step Overview → Timeline →
  Processes → Operations → Recordings (and wrap) from anywhere; body inset
  px-4 py-3 (was p-4); header text no longer runs under the corner `× ⎋`.
- **S39 Setup:** header/footer px-4 py-3 with a 13px title (were px-5 py-4 /
  14px light); Install, Enter path manually…, Copy, Set and Retry are
  standard outline buttons; the path field is the standard input; footer
  `Retry` · `Continue ↩` / `Close ↩`, but on a fresh install with no
  provider it reads `Continue with a Terminal` with NO chip and the left
  says "Escape is off until you choose."; 860 wide.
- **S40 Voice dictation guide:** `Done ↩` (chip from F2); 640 wide (was
  672); body py-3 with gap-4 between sections (was py-4 / gap-6) — check
  the guide still breathes.
- **S42 Extension app window:** corner `× ⎋` (from F4); nothing else changes
  — keys inside the extension belong to the extension.
- **S43 Command palette (⌘⇧P):** every row's shortcut is the standard chip
  (was plain muted text); a thin strip at the bottom reads `↑ ↓ move  ↩ run
  ⎋ close` (↩ insert / open / clear and ⎋ back in the template and AI
  Workspace lists); ⌃N/⌃P and PgUp/PgDn move; hovering no longer steals
  the highlight while the keyboard scrolls the list; the AI Workspace create
  form's buttons are standard with `Cancel ⎋` / `Create ↩`; template scope
  tags are 10px.
- **S45 Settings (⌘,):** the category column is one Tab stop — ↑↓/Home/End
  move and switch category, with a focus ring; ⌘[ / ⌘] switch category from
  anywhere (also on a narrow window, where the column is hidden); on/off
  rows are switches; multi-choice rows (Theme, Accent, Font, …) are one Tab
  stop — arrows move the ring WITHOUT applying, Space/Enter/click applies;
  `Close ⎋` in the header is ghost (was outline).
- **X3 NumberInput (Grid Dispatch lane counts, settings numbers):** the
  field shows the focus ring on its whole rounded box; Tab skips the −/+
  steppers; ↑/↓ in the field step the value (native, not testable here —
  please confirm it steps and clamps).
- **X3 Settings › Apps:** the repo field is now the standard Input (rounded,
  12px code font, focus ring). Install / Load folder / Update are outline
  Buttons, and both Remove buttons are **destructive-outline (red text)**.
  That is a visible change: they were neutral grey. "Retry loading
  extensions" shows a focus ring. Also: the Command keybindings search, the
  pocket URL bar and the headless-probe debug inputs focus with the theme ring
  instead of an accent border.
- **N18 Settings bar:** `caff` and `performance` show the thin focus ring.
  No visual change otherwise. (Whether "caff" should read as something
  clearer belongs to the general UI pass, Task 8.)
- **N12 Claude slash picker (type `/` in a Claude composer):** the
  highlighted row now uses the app's selected-row look (fill + accent rail
  on the left) instead of accent-coloured text. The popover uses the menu
  surface and a theme shadow (it had a hard black shadow, heavy on light
  themes). Keys are unchanged: CC still owns ↑↓↩.
- **N8 focus ring convergence:** the queued-messages header and rows, the
  workflow agent/activity rows and Settings › Dictation's input device select
  now show the thin theme focus ring (they drew a 2px accent outline, a
  second focus look). The feed's jump flash and the Dispatch menu-open
  outline are NOT focus and keep the accent outline.
- **N7 Session views (below the composer, once a workflow exists):** Tab
  lands on the selected view only; ↑/↓ switch views as they move (focus ring
  inset on the row); Tab again reaches "Show all". Check that "Show all" still
  sits at the right end of the Main row at the same height (it is now drawn
  over the row from outside the list, with the row pinned to h-8).
- **N6 Reader header:** the buttons now read "Older ⌥↑" / "Newer ⌥↓" (they
  said "↑ Older" / "↓ Newer", but plain arrows never did that); agent pills
  and both buttons show a focus ring.
- **N5 Spotlight header:** Tab reaches each agent pill (focus ring); the
  Split | Browser | Agent control is ONE Tab stop on the chosen layout, ←/→
  move between the three and Space/Enter choose (arrows never switch the
  layout by themselves). The focus ring sits inside the control's rounded
  ends. Same arrow behavior on Grid Dispatch's "Nested agents" pair.
- **N4 Tiled Dispatch splitters:** Tab reaches the row divider, each row's
  agent-list divider and each lane divider (thin focus ring on the hit
  area); ←/→ move vertical dividers and ↑/↓ the row divider by 2% per press,
  stopping at the same limits the drag stops at (lane 8%, row 12%, agent list
  10–40%). Check the focus ring is visible against the 4px bar in both
  themes.
- **N2/N3 Dispatch sessions list + lane mini strip:** with a session row
  focused, ↑/↓ move the focus ring to the next/previous row (Enter still
  picks it; ⌥↑/⌥↓ still move the lane's selection); the header's cap toggle
  and project button, the "N more" rows and the mini-strip chips show a
  focus ring and a working hover (the `text-fg`/`bg-surface-raised` tokens
  did not exist).
- **N1 Window tab strip:** Tab lands on the active tab (inset focus ring);
  ←/→ switch tabs, Home/End jump, Delete closes the focused tab; the ×
  appears on keyboard focus as well as hover; the "+" shows a focus ring;
  the n/m session badge is 10px (was 9px).
- **M9 Rendering debug inspector:** the "Press Esc to exit" line shows the
  ⎋ chip.
- **M7 Goal loop (⌘⇧G):** the strip across the pane top and the full
  overlay now use real buttons (were browser-default unstyled buttons):
  ghost xs in the strip, outline in the overlay, Stop in red outline, and
  `Close ⎋` (Escape dismisses the overlay); the "Press Escape to close"
  sentence became that chip.
- **M8/N17 Toasts:** the top-right toast text now uses the accent's own
  foreground colour (was hard white — check it on a light theme and a light
  accent); it can be Tabbed to and dismissed with Enter/Space; pane toasts
  are announced by screen readers (live region).
- **M6 New Agent (⌘N) type chooser:** the corner "Choose agent type…" note
  is gone; the card's footer reads `↑ ↓ move  ↩ create` · `Cancel ⎋`
  (ghost, was outline; px-4 py-3); the highlighted type is the row-selected
  colour with an accent bar (was a solid accent fill); ↑ at the top / ↓ at
  the bottom stop (they wrapped); Home/End jump; the card uses popover
  colours and is 360 wide.
- **M4/M5 Explorer right-click menu / path suggestions:** both use the
  popover background, border and theme shadow (were surface + shadow-lg /
  a hard black shadow); the focused explorer menu item is highlighted with
  the row-selected colour; the path suggestion rows use row-selected /
  row-hover and 11px text (were accent-soft and 11.5px); the explorer
  rename field shows its focus border.
- **S44 New Tab (⌘T) path picker:** standard header "New Tab — Working
  Directory", padded body, footer (was one p-6 card); provider toggles show
  a focus ring and announce the chosen one; the path field uses input
  colours; the lowercase prose line became chips `⇥ complete  ↑ ↓ browse
  ↩ open` (+ `⇧↩ new tab` when the folder is already open); footer `Cancel
  ⎋` · `New Session ↩` / `Create & Open ↩`, or `New Tab Anyway ⇧↩` · `Go to
  Tab ↩` / `Stay Here ↩`; the Resume list is now a Tab stop — ↑↓ highlight
  a past session, Enter resumes it; Tab completes only while suggestions
  show — press Escape (or have none) and Tab moves on to the Resume list
  (legend reads `⇥ complete / next`); 640 wide.

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
- [ ] 7. **Keyboard sweep 2** (owner, 2026-09-25: "We have a lot more to do
      keyboard only probably"): a whole-app sweep for mouse-only interactions
      the first inventory missed. Covers pointer handlers on non-interactive
      elements, double-click, context-menu-only, drag-only, hover-only
      reveals, title-only info, hover popovers, unscrollable regions, role
      widgets missing keys, and focus not returned on close. Findings are
      verified by reading, then added as `K2-*` ledger rows and worked like
      the others.
- [ ] 8. **General UI/UX consistency pass** (owner, 2026-09-25: "make the UI
      good and consistent in general, UI and UX, this is supposed to be a
      serious application", to be done "after all of current work"). This
      covers every surface, not only the keyboard-touched ones: type scale,
      spacing rhythm, radius tiers, button variants, headers, empty/loading/
      error states, copy (sentence case, ellipsis, labels), alignment, and
      density. Rows are added as `G-*` in the ledger after task 7.
- [ ] 9. Plan-vs-built, full checks, review round (2 Codex + 1 Pi, own
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

- Ruling (M10/N19): chart hover tooltips, the TimeSeriesChart marker click
  and the Browser Pocket hover thumbnail stay pointer-only. Each is a
  shortcut to information that is also on screen as text (chart totals and
  rows in Usage/Analytics/Performance; the pocket URL in its strip), so a
  keyboard user loses nothing; making chart points Tab stops would add dozens
  of stops per chart — cost if wrong: a follow-up for keyboard chart
  inspection.

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
- 2026-09-25 N2/N3: sessions list — ↑↓ move FOCUS between session rows
  (ruling: not the selection, which ⌥↑↓ already owns, and a focus walk keeps
  the #236 Enter-to-composer routing untouched), aria-current on the lane's
  agent, undefined tokens replaced (closes X5), focus rings on header
  controls and mini-strip chips. Confirm-red: the new test fails on the
  pre-change file. Also: GlobalToast's always-mounted live region added a
  second `status` role, which broke 3 BrowserPocketHost tests using an
  unscoped getByRole('status') — the region is tagged data-global-toast and
  those tests select the pocket's own status (full renderer suite under
  Node 24: 1694/1697 before the fix, all green after).
- 2026-09-25 N1: TabBar → tablist (roving, automatic activation, wrap —
  tabs are a cycle), Delete closes, × on focus-within + named + out of the
  Tab order, live close chord in its tooltip. Confirm-red: both tests fail
  on the pre-change file. CI: first completed run on the branch (36107350937,
  at 5c…) — success.
- 2026-09-25 M7: GoalLoopPane buttons → Button (strip ghost xs, overlay
  outline sm, Stop destructive-outline, Close ghost + ⎋ — Escape dismisses
  via useKeybinds' latch gate). Confirm-red: the extended empty-state test
  fails on the pre-change file.
- 2026-09-25 steering note k8 (valid, wrong-action): the placement
  overlay's document capture listener consumed EVERY Enter, so Tab to Cancel
  + Enter created the highlighted agent. Fixed with the shared
  focusedControlOwnsEnter rule (Escape stays overlay-wide). Fail-first on
  a0902c4a; mutation (drop the guard) fails the test; Space on Cancel is
  untouched; Enter from the list still creates.
- 2026-09-25 M8/N17: Global + pane toasts are always-mounted live regions;
  the global toast is a dismiss button; text-white → text-accent-fg.
  Confirm-red: both toast tests fail on the pre-change files. Caffeinate
  toast layering (z-50 under the dialog scrim) is functional → issue.
- 2026-09-25 M6: placement overlay — clamp (D4), Home/End/⌃N⌃P, listbox
  focus owner with option ids, legend + Cancel ⎋ in its footer, T7 rows.
  Confirm-red: the new test fails on the pre-change file.
- 2026-09-25 M3–M5: sort menu already correct; Explorer context menu and
  PathInput dropdown on popover tokens + T7 rows; PathInput gains combobox
  ARIA (listbox/option ids, aria-activedescendant). Confirm-red: the new
  PathInput test fails on the pre-change file.
- 2026-09-25 S45/N14: Settings — sidebar tablist (roving, arrows select),
  page-level ⌘[/⌘] via sectionCycle, toggles → role=switch, selects →
  radiogroup with roving focus. Ruling: settings radios MOVE on arrow and
  CHOOSE on Space/Enter (not APG's choose-on-arrow) because they apply live
  (theme, update channel) — cost: one extra key. Tests render the sidebar
  and a synthetic SettingsList directly (the full page mounts heavy rows
  unrelated to these contracts); ⌘] tested on the page with the list
  filtered empty. Confirm-red: all 3 fail on the pre-change files.
- 2026-09-25 S43/N10: palette keeps its per-mode Enter handler; adds ⌃N/⌃P
  + PgUp/PgDn, combobox input with aria-activedescendant, rows as option
  with ids in a listbox, mousemove hover, Kbd shortcut column, legend strip
  for list modes, Button for the create sub-form. First mounted palette
  test (recorded dispatch fixture). Confirm-red: both tests fail on the
  pre-change file. NOTE: renderer tests must run under Node 24 — Node 25's
  global localStorage breaks a pre-existing palette test (memory: Node 24
  only); all runs from here use ~/.nvm Node 24.
- 2026-09-25 steering note k7 (valid, high): PathInput preventDefault-ed
  EVERY Tab (incl. Shift+Tab, no suggestions, dismissed dropdown), so the
  new Resume listbox was still unreachable — the S44 test focused the list
  by hand and missed it. Exit rule: Tab completes only while the dropdown
  is open; otherwise Tab/Shift+Tab traverse. Test starts at the real
  initial focus; happy-dom has no native Tab traversal, so it asserts the
  Tab is not prevented AND the Resume list is the next tabbable node in DOM
  order (recorded as a verification-boundary item for the owner checklist).
  Confirm-red on the pre-fix PathInput; mutation (drop `!dropdownOpen`)
  fails it.
- 2026-09-25 S44/N9: path picker anatomy + DialogActions (confirmOnEnter
  false: PathInput owns Enter/⇧Enter; chips honest to what they do), chip
  legend, provider toggle aria-pressed, busy guards on every close path;
  Resume list → Tab-stop listbox on useListNavigation (keyed; unavailable
  rows skipped). Title-cased labels (tests updated). Confirm-red: both new
  tests fail on the pre-change file.
- 2026-09-25 S40/S42: Dictation guide → md preset + T3 body (class swaps,
  owner checklist, no unit test — a test would restate classes); App Host
  needs nothing beyond F4's corner close.
- 2026-09-25 S39: Setup — DialogHeader + DialogActions (must-answer: no
  commit key + legend explaining the refused Escape; otherwise Enter
  continues), 4 raw buttons → Button (scripted), Input for the path.
  Confirm-red: the extended must-answer test fails on the pre-change file.
  Copy: "Continue with a terminal" → "…a Terminal".
- 2026-09-25 S38: Performance — ⌘[/⌘] over its five views, anatomy
  padding, header clears the corner close; window-sized width kept with a
  WHY. Confirm-red: the new test fails on the pre-change file.
- 2026-09-25 S37: Remote panel chrome — DialogHeader + corner close,
  Button for Enable/Show QR/Revoke (guards kept), aria-pressed on the Reach
  switch and the server toggle. Confirm-red: the new test fails on the
  pre-change file.
- 2026-09-25 steering note k6 (valid): (1, high) provider switch by
  arrow/click cleared a typed key without asking — every form-replacing
  path (close, provider switch, Edit, + New Key) now goes through one
  `withKeyFormGuard` (synchronous when nothing is at stake, confirm only
  for a real edit; lock stays unguarded — clearing plaintext on lock must
  not wait). (2, medium) an untouched Edit read as dirty — dirtiness now
  compares against the form's OPENED baseline (value always opens blank =
  keep current). Confirm-red: 3 new tests fail on 5ccef960. Mutations: guard
  bypass on provider switch fails 3 tests; baseline → "non-empty" fails the
  untouched-Edit test.
- 2026-09-25 S36: Key Vault — provider tablist (roving), Input primitive
  (5 pill inputs), Button for 7 text-link actions (scripted), key-form Enter
  save + discard confirm (B7's D3 condition), close-only footer with the
  note moved into the body. Confirm-red: 3 new tests fail on the pre-change
  file.
- 2026-09-25 S35: Analytics — corner close, ⌘[/⌘] over ranges via
  sectionCycle, T3/T5 cleanup, xl preset. Confirm-red: the new test fails
  on the pre-change file.
- 2026-09-25 S34: Usage rail → APG vertical tablist (roving tabindex,
  arrows move focus + selection, wrap), `lib/sectionCycle.ts` for D5 ⌘[/⌘]
  (yields in textarea/Monaco/contenteditable per B7; unit-tested), corner
  close replaces the header "close". Ruling: the rail wraps (tablist, not a
  list) — D4 text corrected. Confirm-red: the 2 new tests and the updated
  role test fail on the pre-change file.
- 2026-09-25 S33/S41: history viewers — Report History focuses a tabbable
  scroller + close-only footer; Workflow History anatomy padding, md
  preset, Button for Show More (label title-cased; test updated). Rule
  recorded: corner `× ⎋` only where a dialog has no footer. Confirm-red:
  the Report History focus/Close test fails on the pre-change file.
- 2026-09-25 S32: Add Skills — Input primitive, Kbd on Find, DialogActions
  (Install: no key — it writes a repository's files into provider
  folders), busy guards on every close path. Confirm-red: the new test
  fails on the pre-change file (two others fail there only on title case).
- 2026-09-25 steering note k5 (valid, both high): (1) Edit Server's dirty
  predicate ignored `secretEdits`, so a secret-only edit was discarded by
  Escape/Cancel without asking — now included (key present = edited; typed
  then emptied deletes the key = reverted; explicit Clear '' = a change).
  (2) Add/Edit Server and the Conventions editor stayed closable while
  saving — each now reports/guards in-flight state (savingRef /
  `busy` in requestClose) + cancelDisabled + escapeCancels. Tests: secret-
  only Escape asks; typed-then-emptied closes without asking; deferred Edit
  save holds against Cancel and Escape (with NO dirty draft, so only the
  in-flight guard can hold it — the first version edited a secret and the
  dirty confirm masked the guard's removal); deferred Conventions save.
  Mutation-checked: removing the secret predicate, the MCP saving guard, or
  the Conventions busy guard each fails its test.
- 2026-09-25 S30/S31: MCP dialogs on DialogActions + size md; Agent MCP
  confirm has no key (it reloads the agent); Add/Edit server Cmd+Enter with
  a dirty-draft discard confirm (child reports dirtiness via a ref). Title
  case labels (tests updated). Confirm-red: both new tests fail on the
  pre-change files.
- 2026-09-25 S28/S29: Conventions + Custom Skills editors — hand-rolled
  outline buttons → Button outline (scripted: rawbtn transform, 10 sites;
  danger/warning-bordered ones left), footers on DialogActions with
  Cmd+Enter and every old guard carried (k3). Title-case labels (test
  lookups updated). Confirm-red: the ⌘↩ test and the in-flight Close test
  fail on the pre-change files.
- 2026-09-25 S27: Theme editor on DialogHeader/DialogActions (Cmd+Enter),
  header Close removed, dirty-draft discard confirm (B7's D3 condition),
  exported for its test. Confirm-red: both tests fail on the pre-change
  component (exported only).
- 2026-09-25 S26: Keyboard Shortcuts — Kbd chips (aria-visible: the chord
  is the content), shared Input, focusable results region (↓ from search,
  PgUp/PgDn page from search), flat rows, close-only footer. Confirm-red:
  both new tests fail on the pre-change file.
- 2026-09-25 S24/S25: editor confirms on DialogActions — Close: confirm =
  Save & Close (focused, Enter saves), Discard destructive-outline extra,
  every `disabled={saving}` guard carried (k3) plus Escape/outside guards
  mid-save; Delete: danger, focus Cancel, no key. Confirm-red: both Close
  tests fail on the pre-change file; the Delete test passes there (it
  already autofocused Cancel and had no key) and stays as a guard.
- 2026-09-25 S22/S23: Quick Open + Search in Files on useListNavigation
  (positional: a new query replaces the ranking; Search resets on search
  start and on results landing), duplicate input-level Escape handlers
  removed (Radix owns it), chip legends, T7 rows. Confirm-red: 2/3 Quick
  Open tests and the Search test fail on the pre-change files (Home/End
  caret test is a guard).
- 2026-09-25 S21: Agent Activity keeps its own handler (type-to-filter,
  Tab-from-filter, Space/⌘A/⌫ layered on keydown, session-keyed highlight)
  and gains K5 movement, listbox/combobox focus owners with row ids, the
  standard header, chip legend + Close ⎋ via DialogActions. Ruling: D3
  exception — Esc clears the filter first here (type-to-filter lands text
  without the user choosing the field; #1105 review asked for it) — cost if
  wrong: one extra Escape; flagged for the owner. The per-row Close button
  is now named "Close <agent>" (the footer's Close closes the view).
  Confirm-red: 3 new tests fail on the pre-change file.
- 2026-09-25 S20: Conversations on useListNavigation (keyed by
  provider:nativeId, reset on head/query/filter change, loadMore near the
  end), input = combobox focus owner in Search mode, listbox in Resume mode;
  ConversationRow takes itemProps (PathPicker still on onHover/onSelect until
  N9); keyboard splitter. Confirm-red: 3 new tests fail on the pre-change
  files.
- 2026-09-25 S18/S19: Queued Prompt viewer focuses its text (read-only
  viewer pattern); debug note on DialogActions with confirmKey Cmd+Enter and
  a discard confirm for typed notes (B7's D3 condition). Ruling: the note's
  cancel stays "Skip" — the bundle is already saved, "Cancel" would claim
  otherwise. Confirm-red: all four new/updated assertions fail on the
  pre-change files (two are the "Queued Prompt" title-case lookups).
- 2026-09-25 steering note k4 (valid, major): Merge opens focused on its
  native Keep <select>, and focusedControlOwnsEnter did not exempt SELECT,
  so Enter to choose the kept tab bubbled to DialogActions and merged.
  Fixed in the shared predicates (SELECT owns Enter and Space); every caller
  only steps aside on true, so the widening cannot make a handler act —
  callers scanned: DialogActions, useListNavigation, Reorder, Pin,
  Conversations (none of their dialogs holds a select). happy-dom cannot
  show whether a real native select consumes Enter before it bubbles, so
  the invariant is protected by a test regardless. Mutation-checked:
  dropping SELECT fails the new Merge test; Enter from a ticked checkbox
  still merges, Enter on Cancel stays Cancel. Migration checklist now:
  carry every old disabled guard (k3) and check every native control in the
  dialog against the Enter predicate (k4).
- 2026-09-25 S17: Merge on one padded body + DialogActions (Enter merges —
  nothing closes). Checked the old footer's disabled guards (only Merge's,
  kept as confirmDisabled) — the k3 lesson, now part of every migration.
  Confirm-red: the new Enter/chip test fails on the pre-change file.
- 2026-09-25 steering note k3 (valid, major): the S13/S14 migration passed
  `busy={closing}` but not `cancelDisabled`, so Cancel (and Escape) could
  hide an in-flight destructive batch — the old footers disabled Cancel.
  Fixed with Bulk Switch's model: cancelDisabled + escapeCancels={!closing}
  + onEscapeKeyDown/onInteractOutside guards. Tests start a deferred close
  and try Cancel and Escape; mutation-checked: dropping either the Cancel
  guard or the Escape guard fails the test in both dialogs.
- 2026-09-25 S16: Root confirm on DialogActions (danger, confirmKey null,
  confirmDisabled until acknowledged). Confirm-red: the new "no grant from
  dialog Enter + chips" test fails on the pre-change file. Copy: "Enable for
  this agent" → "Enable for This Agent".
- 2026-09-25 S13–S15: bulk family on DialogHeader + DialogActions (danger /
  no commit key), DialogActions gained `cancelDisabled`. Ruling: Close
  Completed keeps NATIVE checkboxes (a checkbox group is fully operable —
  Tab + Space, state announced — and each row is an independent
  destructive choice; K5's one-cursor listbox is for highlight lists) —
  cost if wrong: many Tab stops on a long list. Ruling: Bulk Switch's
  confirm has no commit key (spends quota, armed second press compacts on
  the source). Confirm-red: 3 table tests (no Esc button + chips; CloseOld
  focus) and the Close Completed footer test fail on the pre-change files.
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
- 2026-09-25 N4: the three tiled SplitHandles take `onKeyboardDelta` +
  labels + aria values. Drag and keys share `moveWeightBoundary` so the clamp
  has one definition. The layout test's SplitHandle mock now wraps the real
  handle. Confirm-red: 4/4 new tests fail on the pre-change layout; dropping
  `clampIndexFraction` from the key path fails the max-clamp test.
- 2026-09-25 N5: `lib/radioGroupKeys.ts` (`radioGroupKeyDown`) replaces the
  inline copies in SettingsList and ColorFlagPickerModal and drives
  Spotlight's layout radios and Grid Dispatch's nested-agents pair. Rule: arrows
  move and wrap, Home/End jump, modified arrows pass through, Space/Enter
  choose. Confirm-red: both SpotlightView tests and the nested-agents test fail
  on the pre-change components; removing the modifier guard fails the ⌥-arrow
  assertion.
- 2026-09-25 N6: `READER_OLDER_KEY`/`READER_NEWER_KEY` feed both
  `eventMatchesKeybinding` in the listener and `<Kbd binding>` on the buttons.
  Confirm-red: both new ReaderView tests fail on the pre-change view; the
  existing ⌥-arrow and modal-yield tests stay green as the listener regression.
- 2026-09-25 N7: WorkflowViewSelector tablist uses the SettingsSidebar shape
  (↑↓ select, since the list is vertical; the ledger's ←→ was wrong for a
  vertical list). Ruling: no shared tablist helper. The six tablists differ in
  activation (KeyVault guard), Delete-to-close (TabBar/EditorTabs) and
  orientation, so one helper would need a flag per difference. Cost if wrong:
  about 15 duplicated lines per site. "Show all" moved out of the tablist
  (invalid ARIA child) and is absolutely positioned over the Main row.
  Confirm-red: both keyboard tests fail on the pre-change selector; the
  unlisted-selection fallback is pinned by its own test (mutation observed).
- 2026-09-25 N8: 5 `focus-visible:outline-2 outline-accent` sites → T4 (the
  select uses the Input primitive's control form: border-input-border-focus +
  non-inset ring). No new test: a class swap with no behavior, and a
  class-string assertion would restate the diff. Feed.tsx flash and
  DispatchAgentList menu-open outline deliberately left (not focus).
- 2026-09-25 X3: `focus:border-accent` → `focus-visible:border-input-border-focus
  focus-visible:ring-1 focus-visible:ring-focus-ring` (CommandKeybindingsRow,
  PocketChrome, HeadlessSnapshotProbe ×2). AppsSettingsRow raw controls, which
  had NO focus indicator, → `Button`/`Input` (T8). Ruling: Remove uses
  `destructive-outline`, matching destructive actions elsewhere. Cost if
  wrong: a one-word variant change. Intentional `outline-none` without a ring
  kept: caret-signal search inputs (ContentSearch, QuickOpen, Conversations),
  Radix Dialog/Dropdown content (items use data-highlighted), listbox focus
  owners whose active row is the signal (NewAgentPlacement, Rewind scroller
  uses aria-activedescendant rows), the Explorer rename input (always focused,
  focus-coloured border). NumberInput was NOT exempt: it had no focus
  indicator at all → the wrapper draws the ring on `has-[input:focus-visible]`,
  steppers leave the Tab order (APG spinbutton; the field steps with native
  ↑/↓). Confirm-red: its Tab-stop test fails on the pre-change component. ResumePromptModal/CodexApprovalModal belong to N16. No new
  tests: class/primitive swaps; the existing Apps and settings suites cover
  the behaviour.
- 2026-09-25 SCOPE: the owner widened the loop twice mid-run. Keyboard sweep 2
  (Task 7) and the general UI/UX consistency pass (Task 8) come after the
  current N/X rows and before the final review. Order confirmed by the owner:
  "do that after all of current work".
- 2026-09-25 N12: `slashActiveDescendant` / `slashOptionId` in
  SlashCommandPicker; ComposerInput (the focus owner, k2) carries the ARIA only
  while the picker is open. Fixture is hand-built in the parser's output shape
  (no slash-picker recording exists; the component consumes only the parsed
  state). Confirm-red: the linkage test fails on the pre-change composer.
- 2026-09-25 N18: caff toggle `aria-pressed` + accessible name "Keep the
  machine awake (caffeinate)". Confirm-red: the SettingsBar test fails on the
  pre-change bar.
