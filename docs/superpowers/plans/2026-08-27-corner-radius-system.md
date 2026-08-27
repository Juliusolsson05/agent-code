# Corner Radius System

> Refs #666

## Outcome

Replace Agent Code's blanket "no border-radius anywhere" rule with a **semantic
three-token radius system** and a user-facing **Corners** setting, so that radius
means *"this is not part of the grid"* rather than being globally banned — and so
the owner can decide the app's corner language by flipping one setting instead of
by re-reading a stylesheet comment.

The change must leave the tiling grid byte-for-byte square at every setting, and
must make `Corners: Sharp` produce a *genuinely* square app — which today's code
does not, because the existing ban leaks.

## The problem

### 1. The stated rule protects the wrong thing

`src/renderer/src/styles.css` opens with:

```
 *   1. No border-radius anywhere. Sharp rectangles.
```

That rule is doing real structural work, but it is aimed one level too broadly.
Agent Code is a tiling window manager for agent sessions. Tiles that share an edge
must butt flush — a rounded tile in a 2×2 split leaves a visible notch at every
seam, and no amount of taste makes that acceptable. *That* is the invariant.

"No radius anywhere" is a much stronger claim than the invariant needs, and
everything that never touches a seam inherited the ban by accident: dialogs, the
command palette, context menus, toasts, badges, keycaps, and the inset code slabs
in the feed. None of those share an edge with anything. They float over the grid
or sit inside a scroll column, and several of them already carry a shadow or a
scrim precisely *because* they are detached — radius is the other half of that
signal, and it was never available to them.

### 2. The shipped app is not actually sharp

The ban is enforced by zeroing the Tailwind radius scale:

```css
--radius-none: 0px;
--radius-sm: 0px;
/* … through --radius-3xl */
--radius-full: 9999px; /* preserved ONLY for the streaming dot */
```

That override is incomplete in three separate ways, and the result is that
~30 call sites are rounded *right now* while the comment says they are not:

- **Bare `rounded` is not covered.** Tailwind v4 resolves the suffix-less
  `rounded` utility against `--radius: 0.25rem`, which lives in a **separate
  `@theme default inline reference` "Deprecated" block** in
  `node_modules/tailwindcss/theme.css` (line 508) — *not* in the `--radius-*`
  scale this file overrides (lines 397–404). So every bare `rounded` renders at
  **4px today**: the global-editor toolbar buttons, `WorkflowPhaseSection`,
  `WorkflowActivityRow`, `WorkflowAgentDetails`, the explorer context menu and
  its rename input, `EditorTabs` nav buttons, `EditorStatusBanner`,
  `AgentStatusPanel`, the command-palette scope badges, `ContentSearchOverlay`,
  the `RenderingDebugInspector`, `GitOperationView`'s ref chips, and the
  ask-user-question chip.
- **`--radius-xs` is not covered** either (0.125rem), though nothing currently
  uses `rounded-xs`.
- **Arbitrary values bypass the scale entirely.** `rounded-[3px]` emits
  `border-radius: 3px` regardless of any token — `PaneHeader`, `TerminalLeaf`,
  and `AgentTerminalLeaf` badges are all 3px today.

So the app is not square; it is an unlabelled mixture of 0px, 3px, and 4px, with
a header comment asserting 0px everywhere. Whatever the aesthetic outcome, those
sites should name a token that says what they mean.

## The rule this installs

Radius becomes a **classification**, not a global switch:

| class | token | applies to | rationale |
|---|---|---|---|
| **structure** | none (`0`) | tile leaves, pane headers, tab bars, terminal, editor, feed rows, worktrees bar, settings sections, side panels, status bars | shares an edge with a neighbour; must stay flush |
| **capsule** | `--radius-chip` | badges, keycaps, counters, status pills, color flags, scope tags | an object, not a region |
| **slab** | `--radius-slab` | code blocks, tool output, diff blocks, image thumbnails, the user-prompt highlight | an inset content plate inside a scroll column |
| **float** | `--radius-float` | dialogs, command palette, popovers, context menus, toasts, the dictation overlay | detached from the grid; already carries shadow/scrim |

The test for "is this structure?" is mechanical and does not require taste:
**does this element share an edge with a sibling that must line up with it?**
If yes, it is structure and gets `0`. That question has an answer for every
surface in the app, which is what makes the rule enforceable by review.

### Why "sudden"

The values are deliberately discontinuous. There is no 2px tier, because a 2px
radius on a monospace terminal-adjacent UI reads as a rendering artifact rather
than a decision — it is the worst of both languages. The system offers `0` or a
radius you can actually see, and the `Round` tier goes as far as full-pill chips
so the change is unmistakably intentional.

## Design: tokens resolved at runtime

The tokens follow the mechanism the accent picker and the font picker already
use, and for the same reason: a settings change must cascade through the DOM
with **zero React work**.

```css
@theme inline {
  --radius-chip:  var(--theme-radius-chip);
  --radius-slab:  var(--theme-radius-slab);
  --radius-float: var(--theme-radius-float);
}
```

Tailwind emits `rounded-chip` / `rounded-slab` / `rounded-float` as utilities whose
value is a `var()` reference. `applyTheme` writes the three `--theme-radius-*`
custom properties inline on `<html>`, where they outrank the `[data-mode]` blocks
exactly as the accent tokens do. Switching Corners is three
`root.style.setProperty` calls and nothing re-renders.

**Why not put radius into `customAppearance`:** that contract is
`CUSTOM_APPEARANCE_COLOR_KEYS` — 80 keys, all colours, validated as colours, and
surfaced in the theme editor as colour fields. Threading three lengths through a
colour pipeline would mean either weakening its validation or special-casing three
keys in every consumer. Radius is a different axis with three sensible presets, not
80 free values; it gets its own top-level setting alongside `accent` and
`fontFamily`.

**Why the presets are a closed enum and not a number input:** the interesting
question is "which corner language does this app speak", not "is 7px better than
8px". A free length invites per-token drift and gives the review no fixed point to
check `Sharp` against. Three named tiers keep `Sharp` a *guarantee* — every token
is literally `0px` — rather than a value someone can approximate.

### The preset table

|  | `chip` | `slab` | `float` |
|---|---|---|---|
| **Sharp** | `0px` | `0px` | `0px` |
| **Soft** | `3px` | `4px` | `6px` |
| **Round** | `9999px` | `8px` | `14px` |

`Soft` is the restrained reading — visible, but it does not change the app's
character. `Round` is the sudden one: chips become true capsules and floating
surfaces read as cards sitting on top of the workspace.

**Default: `Round`.** The request was explicitly for a *sudden* change, and a
default of `Soft` would make the branch's first impression the timid version of
the thing that was asked for. Changing the ship default afterwards is a one-line
edit to `DEFAULT_SETTINGS.cornerStyle` — the point of building the dial is that
the taste call is cheap to move and does not need to be re-litigated in code.

## Implementation stages

### Stage 1 — Tokens and the stylesheet rule

`src/renderer/src/styles.css`

- Rewrite hard rule #1 to state the real invariant ("no radius on the grid;
  radius marks detachment") and point at the token table. The header is the
  closest thing this repo has to a design source of truth for the renderer, and
  leaving it asserting a ban the code contradicts is how the next agent
  reinstates the ban.
- Keep `--radius-none` and the whole legacy `--radius-sm … --radius-3xl` scale
  pinned at `0px`, and **add** `--radius-xs: 0px` and `--radius: 0px` to close
  the two leaks. Component code that has not been migrated must not
  silently pick up 2px/4px from a Tailwind default; a class that has not been
  classified renders square, which is the safe direction.
- Add the three semantic tokens to `@theme inline`.
- Declare `:root` fallbacks for `--theme-radius-*` matching the default preset,
  so the window between first paint and `applyTheme` is not unstyled. (The store
  calls `applyTheme` synchronously on creation, so the window is theoretical —
  but the phone client calls `applyTheme` on an uncoerced blob, and a static
  fallback is what keeps a bad blob from producing `border-radius: ` with an
  empty value.)
- `.code-block-shell`, `.code-block-static`, and `.prose-theme pre` take
  `border-radius: var(--theme-radius-slab)`. `.code-block-shell` additionally
  needs `overflow: hidden` so Monaco's canvas is clipped by the rounded corner
  rather than painting over it.

`src/remote-client/src/styles.css`

- The phone client compiles its own Tailwind from the renderer stylesheet but
  keeps a small hand-written sheet with its own copy of the hard rules. Mirror
  the tokens and the rule text so the two builds do not drift into disagreeing
  about what the app's corner language is.

### Stage 2 — The setting

`src/renderer/src/app-state/settings/types.ts`

- `CornerStyleId = 'sharp' | 'soft' | 'round'`, a `CORNER_STYLES` meta array in
  the shape of `AGENT_VIEW_MODES` (`id` / `label` / `description`) carrying the
  three radius values per tier, `cornerStyle` on `Settings`, and the default.
- The meta array is the single source of truth for the numbers. `applyTheme`
  reads them from there; nothing hardcodes a second copy.

`src/renderer/src/app-state/settings/persistence.ts`

- Coerce `cornerStyle` against `CORNER_STYLES`, falling back to the default —
  matching the `agentViewMode` line exactly. An unknown persisted value (a blob
  from a newer build, a hand-edited file) must not reach `applyTheme`.

`src/renderer/src/app-state/settings/theme.ts`

- `applyTheme` resolves the preset and writes the three custom properties, next
  to the existing font/accent writes. Same defensive `?? CORNER_STYLES[0]`
  pattern the font lookup uses, for the same reason: the phone client calls this
  with an uncoerced blob.

`src/renderer/src/features/settings/lib/settingsRegistry.ts`

- A `select` control under the appearance category, `columns: 3`, with the tier
  descriptions as option copy. Per `docs/command-style.md` the title is a stable
  noun — **Corners** — not "Toggle Rounded Corners".

### Stage 3 — Apply the classification

Migrate call sites onto the semantic utilities. Every edit in this stage is
either (a) an existing accidental `rounded` / `rounded-sm` / `rounded-[3px]`
being told what it actually means, or (b) a float/slab/capsule surface that
should have had radius available to it all along.

**float** — `components/ui/dialog.tsx` (`DialogContent`), `CommandPalette`
shell, `ExplorerPane` context menu, `GlobalToast`, `VoiceDictationOverlay`,
`ContentSearchOverlay`, `SlashCommandPicker`, `PathPicker`, session preview.

**slab** — `.code-block-shell` / `.code-block-static` / `.prose-theme pre` (CSS,
Stage 1), `StreamingCodeText`, `DiffSlab`, `GitOperationView`'s output block, the
provider `bg-code-bg` `<pre>` blocks in the permission/trust modals,
`ComposerInput` image thumbnails, the user-prompt highlight in
`feed/ui/rows/primitives.tsx`.

**chip** — `SessionBadges`, `PaneHeader` / `TerminalLeaf` / `AgentTerminalLeaf`
badges (the `rounded-[3px]` sites), `DispatchAgentList` flags,
`WorktreesBar` badges, command-palette scope badges, `GitOperationView` ref
chips, the ask-user-question chip.

**left alone deliberately** — `rounded-full` on the streaming dot, connection
dots, tab dots, the dictation level meter, and the colour-flag swatches. Those
are circles by geometry, not by corner policy, and must not track the setting:
a `Sharp` selection turning the streaming dot into a square is a bug, not
consistency.

Structure surfaces are not touched at all. If a diff in this stage adds a radius
class to a tile leaf, a tab bar, a pane header container, the terminal, the
editor, or a feed row container, that is the review's fail condition.

### Stage 4 — Verification

- `npm run typecheck` (both projects — `tsc -b` is the repo's only type gate;
  neither `electron-vite build` nor Vitest type-checks).
- `npm test`.
- A renderer test pinning the contract that actually matters: `Sharp` writes
  `0px` to all three properties, `Round` writes the pill/8/14 set, and an
  unknown persisted value coerces to the default rather than writing `undefined`.

## Testing decisions

The behaviour worth protecting is **the guarantee**, not the numbers. A test
asserting `soft.slab === '4px'` is tautological — it restates the table it reads
from — and it fails every time the taste call moves, which is the one thing this
design expects to change.

What can genuinely break, and therefore gets a test:

1. **`Sharp` is total.** Every token is exactly `0px`. This is the promise that
   makes the feature safe to ship; if a future tier edit leaves `chip` at
   `9999px` under Sharp, the streaming-dot-shaped bug ships silently.
2. **An unknown persisted `cornerStyle` coerces to the default.** The failure
   mode is `root.style.setProperty('--theme-radius-chip', undefined)`, which
   yields an app with no corner tokens at all.
3. **`applyTheme` writes all three properties.** A partially-applied preset (two
   of three written) is the shape a copy-paste error takes here.

No corpus or fixture work is involved — this touches none of the rendering
ownership pipeline, only presentational classes. `docs/rendering/rendering-design-principles.md`
does not apply: no `RenderReason`, no ownership decision, no ledger input changes.

## Risks and known limitations

- **Monaco clipping.** `.code-block-shell` hosts a Monaco instance. Rounding the
  shell without `overflow: hidden` leaves the editor canvas painting square
  corners over the rounded parent. Handled in Stage 1; worth a visual check.
- **xterm surfaces read CSS variables through a `THEME_CHANGED_EVENT`
  subscription, not through the DOM.** They are structure and get no radius, so
  nothing needs to be added to that path — but this is the reason to confirm no
  terminal surface picked up a class in Stage 3.
- **Nested radius.** A `rounded-float` dialog containing a full-bleed
  `rounded-slab` code block can show a hairline of parent background in the
  corner gap. Where a slab is full-bleed inside a float, the float owns the
  clipping via `overflow-hidden`.
- **The phone client is a second build.** Its Tailwind compiles from the renderer
  stylesheet, so the utilities exist, but its hand-written sheet needs the token
  declarations or `var(--theme-radius-*)` resolves to nothing there.
- **This is a taste change on a documented hard rule.** It is shipped behind a
  setting whose `Sharp` value is a byte-for-byte return to the old look
  (strictly: a *more* square app than today, since it closes the 3px/4px leaks),
  so the cost of rejecting it is one setting change, not a revert.
