# Command Palette — Sort Modes

> **Status:** in progress. Branch `feat/command-palette-sort-modes`.
>
> **Problem owner:** mouse-first browsing. The palette's empty-query list is ~99
> rows in catalog registration order, with no visual structure. A keyboard user
> types three characters and the ranker does the work; a mouse user scrolls a
> flat undifferentiated list and scans.

---

## 1. Why this exists

The palette has exactly one ordering story today, and it is optimized for the
keyboard:

- **Typing** → `rankEntries` tier ladder (prefix > substring > acronym >
  keyword > body > subsequence). Excellent.
- **Not typing** → catalog registration order, verbatim, with starred commands
  hard-partitioned to the top.

Catalog order is *deliberate* — `catalog.ts` calls it a user-visible invariant
and `catalog.test.ts` pins it — but it is deliberate about **authoring
adjacency** ("like things stay adjacent"), not about **findability**. A user who
does not know the command's name gets no affordance at all: no alphabet to
binary-search, no categories to narrow by eye.

This is the gap. It is a *browse* problem, not a *search* problem, and it only
bites when the query is empty.

### Why not a filter control

The obvious second half — filter chips per surface — is deliberately **not**
built. Grouping already answers the question filtering would answer ("show me
only session commands") without adding state, without a second control to keep
consistent with the first, and without a mode where the user can filter
themselves into an empty list and not know why. If browsing by group turns out
to be insufficient, filtering is a separate, later change.

---

## 2. The design

**One control. Four modes. Empty query only.**

### 2.1 Modes

| Mode | Order | Serves |
|---|---|---|
| `catalog` | Catalog registration order (today's behavior) | the existing muscle memory; the default |
| `alpha` | Title, `localeCompare` | "I know the name, I just can't spot it" |
| `grouped` | By `category`, section headers, alphabetical within group | **browsing / discovery** — the actual reported pain |
| `recent` | History score DESC, then catalog order | muscle memory, made explicit |

`grouped` is the one that motivated the feature.

**Grouping keys on `CommandCategory`, not `CommandSurface`.** The first
implementation used `surface` and that was wrong on both counts:

- *Correctness.* `CommandCategory`'s doc comment records that `surface` is a
  MACHINE applicability dimension driving mode gating, and that reading it as a
  category is a conflation the codebase already paid for once in the Settings
  list — "once one field means both, you cannot reclassify a command's
  presentation without changing when it applies."
- *Fitness.* By surface the buckets are app 41 / dispatch 34 / session 32 /
  grid 11 / debug 11 / editor 9, and since grid and dispatch are mutually
  exclusive one section holds ~40% of the visible list — barely a narrowing. By
  category they are session 24 / layout-dispatch 16 / navigate 12 /
  developer 12 / workspace-tools 11 / editor-files 10 / create 10 /
  preferences 3.

`category` is optional on `CommandDef` until the governance migration completes,
and extension-contributed commands cannot declare one, so uncategorized rows get
a trailing **Other** section rather than being silently dropped from the one
mode built for discovery.

### 2.2 The cardinal rule is preserved

**Sorting applies to the empty-query browse state only.** The moment the user
types, `rankEntries` relevance ordering wins outright and the sort mode is inert.

This is not a limitation to be lifted later — it is the same invariant
`rankEntries` and `rankCommands` already defend in three separate comment blocks:
*a text match always beats every other signal*. A sort mode that reordered search
results would let "A–Z" push a tier-5 prefix match below a tier-1 subsequence
match, which is precisely the inversion class this subsystem was rewritten to
eliminate.

The UI makes this legible rather than mysterious: while a query is present the
control **shows `Relevance` and disables itself**. The user is told what the
ordering is instead of wondering why their chosen sort stopped applying.

### 2.3 Composition with starring

Starring already perturbs the resting order — `rankCommands` hard-partitions
starred commands to the top on an empty query, and its comment block explicitly
defends that against the "resting order must not shuffle" rule (a star is a
deliberate act by the person now looking at the list).

Sort modes compose **inside** that partition rather than replacing it:

```
  ┌─ starred ────────────┐
  │  sorted by mode      │   ← stars stay pinned; sorting orders within
  ├─ everything else ────┤
  │  sorted by mode      │
  └──────────────────────┘
```

In `grouped` mode the partition simply becomes visible as a leading **`★
STARRED`** section, which is more honest than the current invisible split.

Rationale: starring answers *"which commands are mine"*; sorting answers *"how
do I want to scan the list"*. They are orthogonal questions and neither should
silently cancel the other. Making sort override starring would mean the user's
explicit pins vanish the moment they pick A–Z — an obviously wrong outcome.

### 2.4 Layout

Header, `commands` mode, empty query:

```
╔═══════════════════════════════════════════════════════════════╗
║  Type a command…                              [ ⇅ Grouped ▾ ] ║
╠═══════════════════════════════╤═══════════════════════════════╣
```

Open menu:

```
                              ┌──────────────────────────┐
                              │ ✓ Catalog order          │
                              │   A – Z                  │
                              │   Grouped                │
                              │   Recently used          │
                              └──────────────────────────┘
```

With a query present:

```
║  reader                                    [ ⇅ Relevance ]    ║
                                              ▲ disabled, title=
                                              "Sorting applies when
                                               the search box is empty"
```

`grouped` list body:

```
║  ── ★ STARRED ──────────────────                              ║
║  ★ Reader Mode                ⟨ON⟩     ⌘⇧R                    ║
║  ── CREATE ─────────────────────                              ║
║    New Agent…                          ⌘N                     ║
║    New Tab                             ⌘T                     ║
║  ── SESSION ────────────────────                              ║
║    Reload Agent                                               ║
║    Rewind to Prompt…                                          ║
```

The `★` column and the starred-block divider come from the starring feature
(#619) and are preserved: in `grouped` mode the divider is suppressed, because a
labelled `★ Starred` heading already says what the unlabelled rule was there to
imply.

The control sits in the same header slot `Manage` already occupies in
`prompt-template` mode, so no new layout geometry is introduced.

---

## 3. Architecture

### 3.1 New module: `lib/sortCommands.ts`

Pure, no React, no storage, no `Date.now()` — same contract as its neighbours
`rankEntries.ts` and `rankCommands.ts`.

```ts
export type CommandSortMode = 'catalog' | 'alpha' | 'grouped' | 'recent'

browseOrder(commands, mode, historyScore, starred): BrowseOrder
groupCommands(commands, starred): CommandGroup[]   // grouped mode only
```

`groupCommands` returns `{ label, commands }[]`, so the component renders
headers without knowing the category taxonomy. Group order is fixed and
declared in the module:

```
★ Starred · Create · Navigate · Session · Layout & Dispatch ·
Editor & Files · Workspace Tools · Preferences · Developer · Other
```

`grid` and `dispatch` are mutually exclusive at runtime (`surfaceAvailable` in
`registry.ts` hides one or the other), so at most one of those two ever renders.
Empty groups are dropped.

### 3.2 `rankCommands` gains a mode parameter

```ts
rankCommands(commands, query, historyScore, starred, sortMode)
```

- `query.length > 0` → unchanged. Returns `rankEntries` output verbatim.
- `query.length === 0` → partition by star (existing behavior), then
  `sortCommands` each half.

The existing star partition stays exactly where it is and keeps its comment
block. This change adds a step *inside* each half; it does not restructure the
partition.

### 3.3 Selection model — headers must not break it

`selectedIndex` indexes `paletteCommands`, a flat array. Grouped mode inserts
header elements into the DOM but **must not** make them selectable: arrow keys,
Enter, hover and the clamp effect all stay index-over-commands.

So: `paletteCommands` stays flat and authoritative. Grouping is a **render-time
concern only** — a `Map<number, string>` of "header to draw before row *i*",
consumed inside the existing `.map()`. Nothing in the keyboard handler changes.

### 3.4 The `scrollIntoView` fix (opportunistic, in blast radius)

```ts
const el = listRef.current.children[selectedIndex]   // ← positional
```

This assumes list children map 1:1 onto `selectedIndex`. That is **already
false**: `ai-workspace-open`/`clear` render an error banner as a sibling child of
the same container, so while an error is showing every scroll target is off by
one. Grouped mode's headers would make it wrong in a fourth mode.

Fix once, properly: every selectable row in every mode gets
`data-palette-row={i}`, and the effect resolves by attribute:

```ts
listRef.current.querySelector(`[data-palette-row="${selectedIndex}"]`)
```

Positional indexing into rendered children was a latent bug waiting for exactly
this kind of change; the attribute makes the row's identity explicit and immune
to sibling chrome.

### 3.5 Persistence

`Settings.commandSortMode: CommandSortMode`, default `'catalog'`.

Coerced in `persistence.ts` against the valid set, falling back to `'catalog'` on
anything unrecognized — same shape as the existing `coerceCommandStarred` /
`coerceCommandVisibilityOverrides` guards, and for the same reason: a
hand-edited or version-skewed blob must degrade, never throw into render.

Default `'catalog'` keeps the change **purely additive**. Fresh installs and
existing users see the exact palette they see today until they choose otherwise.

### 3.6 New component: `ui/CommandSortControl.tsx`

Its own file rather than another closure inside a 2100-line component — the
palette is already too big, and a self-contained popover with focus and
click-outside handling is exactly the kind of unit that should be readable on its
own.

Focus discipline, which is the whole difficulty:

- `onMouseDown` → `preventDefault()` on the button and every menu item, so the
  search input **never loses focus**. Typing immediately after picking a sort
  must work.
- Click-outside closes, via a `pointerdown` listener on `document` while open.
  `pointerdown` rather than `click`, so a press landing on a palette row closes
  the menu before that row's command can run.
- **All menu keys are handled on `document` in the CAPTURE phase.**

That last point was the design's one real mistake, caught in review. The first
implementation put a React `onKeyDown` on the control's root — which is
unreachable dead code, because `keepFocusInSearchInput` guarantees focus never
enters the subtree, and the search input is a *sibling* of the control, not a
descendant. Three keys went to the wrong widget:

| Key | Where it actually went |
|---|---|
| Escape | Radix's dismiss handler — **closed the whole palette** |
| ↑ / ↓ | moved the selection in the list *behind* the open menu |
| Enter | ran `paletteCommands[selectedIndex]` from that hidden list |

Capture-phase on `document` beats both competitors: React 18 delegates synthetic
events to the root container (a descendant of `document`, so later), and Radix's
dismiss layer listens on `document` in the bubble phase (later still). One
listener therefore fixes all three, and makes the menu genuinely keyboard-operable
— which its ARIA roles were already promising.

The keyboard cursor is component state, not DOM focus, so the highlight is
painted from `highlighted` rather than `:focus`; hover writes to the same state,
exactly as the palette's own rows do.

---

## 4. Files

| File | Change |
|---|---|
| `lib/sortCommands.ts` | **new** — modes, sorting, grouping, labels |
| `lib/sortCommands.test.ts` | **new** — pure unit tests |
| `lib/rankCommands.ts` | mode param; sort inside each star partition |
| `lib/rankCommands.test.ts` | **new** — star × sort composition, query-wins invariant |
| `ui/CommandSortControl.tsx` | **new** — button + popover |
| `ui/CommandSortControl.renderer.test.tsx` | **new** — the keyboard contract |
| `ui/CommandPalette.tsx` | wire control, render group headers, `data-palette-row`, scroll fix |
| `registry.ts` | carry `category` through to `ResolvedCommand` |
| `types.ts` | `ResolvedCommand.category`; note that `surface` is not a grouping axis |
| `app-state/settings/types.ts` | `commandSortMode` field + default |
| `app-state/settings/persistence.ts` | `coerceCommandSortMode` |

---

## 5. Testing

Colocated, per `testing/README.md`. The valuable surface here is pure, so the
tests are pure:

**`sortCommands.test.ts`**
- `catalog` returns input order by reference-equal content (identity behavior).
- `alpha` sorts by title; ties fall back to catalog index deterministically.
- `recent` puts history-scored commands first, unscored keep catalog order.
- `grouped` emits groups in the declared fixed order, drops empty groups,
  sorts alphabetically within a group.
- `grouped` emits `★ Starred` first and only when something is starred.
- `grouped` keys on **category, not surface** — every fixture shares one
  surface, so a regression to the old axis collapses them into one section.
- Uncategorized commands land in a trailing `Other` section rather than
  vanishing.

**`rankCommands.test.ts`**
- **The invariant:** a non-empty query ignores sort mode entirely — results are
  asserted *byte-identical* across all four modes, not merely "the winner stayed
  on top".
- Starred commands stay partitioned above unstarred under every mode.
- Sorting applies within both partitions, not across them.

**`CommandSortControl.renderer.test.tsx`**

This file exists because the plan originally declined it, and review found
exactly what that let through. The reasoning — "a test asserting a menu opens on
click pins the implementation, not the contract" — was right about *opening* and
wrong about *keys*: Escape closing the whole palette, and ↑/↓/Enter driving the
list behind an open menu, are contract violations a user can observe.

The tests reproduce the real DOM relationship (search input as a **sibling** of
the control, focus in the input) and assert behavior, not structure. All of them
fail against the pre-review implementation.

---

## 6. What this deliberately does not do

- **No filter control.** See §1. Grouping subsumes the need; two controls is a
  consistency burden for a benefit nobody has asked for yet.
- **No sort in the other four palette lists** (sessions, buried, templates, AI
  workspaces). They are short, already have meaningful intrinsic orders
  (recency, `[...custom, ...builtin]`), and none of them is the reported pain.
- **No keyboard shortcut to cycle sort.** This is a mouse-first affordance by
  construction; a keyboard user types and gets relevance, which is better than
  any sort. Adding a chord would spend a scarce binding on the users who need it
  least.
- **No per-mode memory** (e.g. "grouped in commands mode, alpha elsewhere").
  One setting, one behavior.
