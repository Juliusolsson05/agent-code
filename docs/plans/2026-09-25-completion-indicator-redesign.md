# Completion indicator: make the header itself the patterned plate

Status: **proposed, awaiting owner approval** · Branch: `fix/completion-indicator-redesign` · Issue: #1200
History: #1172 / PR #1176 (45% diagonal stripes) → #1191 / PR #1192 (full-accent vertical bars + surface plates, which looked broken) → this plan.

How this plan was made: the owner asked for heavy reading plus a Codex planning agent. A Codex agent investigated read-only and wrote the plan below. Claude read the same code independently (theme tokens, `ACCENTS`, the terminal leaves' slot colouring) and reached the same core design, then adopted this plan with the owner decisions listed first. The contrast table was computed from the repository's real accent pairs, not from a rendered app; the app was not launched.

## Owner decisions needed before implementation

1. **The design (recommended).** The finished state is the working bar itself: the same row, height and `accent-fg` text, with vertical bands of **full accent (8px)** and **15%-darker accent (4px)** instead of solid. No plates. Alternative: 7px/7px equal bands.
2. **Frost on light themes (recommended: fix it in this PR).** Frost's light accent `#5e81ac` already fails text contrast with its text colour (3.83:1, below 4.5:1). That also affects the existing working fill, so the new bands cannot fix it. The recommendation changes Frost-light to `#507097` (4.86:1), which shifts Frost's hue slightly on the two light themes everywhere the accent is used. Alternative: leave it and record it as a known exception.

Claude's earlier idea, "lighten the second band on dark themes, darken it on light themes, based on accent-fg", is superseded by the fixed 15% black mix. The measured evidence is in "Risks and rejected options": the dark accents all tolerate the darkening, and lightening bright accents such as Gold barely shows as a pattern.

## Outcome

An unseen completion is one continuous accent-colored header, with vertical bands running behind its label, path, and terminal slots. A working header is the solid member of the same visual family. Both use the same foreground and geometry. There are no opaque surface islands inside either bar.

The owner's explicit requirements are non-diagonal stripes, full activity color, and the row/text belonging together like the working state. The particular band widths, secondary shade, and Frost-light correction below are my recommendations, not previously approved requirements.

```text
Status Mode ON                 text sits directly on the row in accent-fg
working    [ B6  …/agent-code             TAIL ][ manual flag ]
background [ AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ][ solid flag  ]
finished   [ B6  …/agent-code             TAIL ][ manual flag ]
background [ AAAABBAAAABBAAAABBAAAABBAAAABBAAAA ][ solid flag  ]
seen       [ B6  …/agent-code             TAIL ][ manual flag ]
background [              surface              ][ solid flag  ]

A = unchanged full accent; B = opaque darker shade of that same accent.
The text/box lines explain layers, not additional UI rows or plates.
Status Mode OFF: same state geometry, with 4px top/bottom content padding;
working stays surface-colored, while finished still gets the patterned row.
```

## Evidence — verified, do not re-derive

1. **Observed failure:** `.review-briefs/stripes-broken.png` shows a long path and pane-label plate covering most of the status row, leaving disconnected bars at its ends. `PaneHeader.tsx:169–189` wraps the label, badge, and path together; `.pane-header-completion-plate` in `styles.css:1191` paints the entire wrapper opaque surface. The wrapper grows with the path. The CSS is doing what #1192 asked for; its design hides the signal in the common long-path case. No new live reproduction was run, per the brief.
2. **History:** the two earlier plans and the actual PR bodies were read. #1176 chose a 45% accent/surface pattern. #1192 replaced it with full-accent/transparent 7px/7px bars and plates to avoid text crossing unlike backgrounds. Its tests assert that plates exist; its PR explicitly reports no visual app check. Recoloring alone was rejected for the OLD accent/surface pattern, not for two opaque accent tones. No review/comment payloads were attached to #1192 in the fetched metadata.
3. **Paint ownership:** `PaneHeader.tsx:87–113` separately derives working (`paneHeaderStatusLit(statusMode, isSessionLive)`) and completion (`showAgentCompletionIndicator && completionUnseen && !isSessionLive`). Only working currently selects `bg-accent text-accent-fg`; completion inherits `bg-surface text-muted` and adds a background image. This must change with plate removal.
4. **Actual settings:** `app-state/settings/types.ts:718–719` defaults BOTH `showStatusMode` and `showAgentCompletionIndicator` to `true`. This contradicts the brief's “Status Mode off is the default.” Do not change either preference/default as part of this redesign. Treat off-mode as a first-class acceptance case because it is specifically requested and supported.
5. **Actual height:** `min-h-[5px]` is not `h-[5px]`. The pane chip stays visible and has `leading-[14px]` plus two 1px borders, so with that chip the row is at least 16px in Status Mode, approximately 24px with `py-1` off-mode. Other content/fonts can determine a larger height. These are source-derived bounds, not measured app dimensions. No source here hides the text in Status Mode. Existing “~5px strip” comments are misleading.
6. **Palette source correction:** `styles.css:77–78` aliases the Tailwind accent tokens to `--theme-accent` / `--theme-accent-fg`. CSS has Frost fallbacks (`314–315`, `390–391`, `553–554`), not all eight selectable accents. `settings/theme.ts:applyTheme` writes the actual pair from `settings/types.ts:ACCENTS` inline on `<html>`, taking precedence over CSS. Computing all accents from CSS alone would silently measure Frost eight times.
7. **Six built-in themes, two accent families:** Nord, Dark, Gray Dark, and Tokyonight use the `dark`/`fgDark` pair. Light and Soft Light use `light`/`fgLight`. High-contrast blocks in `styles.css:500–538` and `640–676` change surfaces/inks, not this inline accent pair; opaque-band text ratios therefore do not change with the high-contrast toggle.
8. **Callers:** the shared workspace header has three production callers: `TileLeaf.tsx:804`, `AgentTerminalLeaf.tsx:635`, and `TerminalLeaf.tsx:672`. The similarly named local function in `features/session-preview/ui/SessionPreviewPane.tsx` is unrelated. TileLeaf supplies no badge/trailing slot. Both terminal leaves currently recompute the working-only lit rule for badge/TAIL colors.
9. **Lifecycle is out of this fix:** the agent leaves pass `runtime.unreadKind !== null`; shells do not opt in. `useAcknowledgeAfterDwell` owns acknowledgment. #1176 explicitly records that interrupted turns and attention markers can also stripe under this predicate; “completion” is the existing UI name, not a newly narrowed unread kind.
10. **Second row is structurally separate:** `AgentTitleHeader.tsx` renders `bg-canvas text-ink`, including an agent-name placeholder that reserves height before the name arrives. The stale comment in `PaneHeader.tsx:221–226` says untitled agents have no row; names/reservation make that statement false. Do not use it to remove the row.

## Decisions

1. **Pattern — recommended:** 8px full accent + 4px darker accent, repeating vertically with a 12px period, static. This leaves two-thirds of the width exactly the activity color and uses a narrower second band to read as a pattern on one bar. Alternative: equal 7px/7px opaque tones; sound structurally, but more visual weight for the shade. Horizontal bands are less dependable when the row is shallow.
2. **Second tone — recommended:** `color-mix(in srgb, var(--theme-accent) 85%, #000000)`. Use exactly the same derivation in every built-in theme. It is opaque and keeps the accent's hue; it is not a transparency wash onto the surrounding surface. Existing dark-accent foregrounds still have at least 5.268:1 on this darker band; light foregrounds gain contrast there.
3. **Frost light — recommended, explicit palette scope:** change its light accent from `#5e81ac` to `#507097`, retaining `fgLight: '#faf9f6'`. Update the matching light CSS fallback. This changes Frost-light activity color everywhere that uses the shared accent, so working and completion stay identical in hue. It raises full-band contrast from 3.827:1 to 4.858:1 and shaded-band contrast to 6.226:1. It is a deliberate departure from exact Nord `nord10`, limited to Frost in the two light themes. See alternatives below; do not hide this change in a stripe CSS patch.
4. **Geometry and preferences — recommended:** preserve current row, padding, label sizes, independent setting gates, and flag allocation. No special completion height; no enabling working fill when Status Mode is off.
5. **Slot contract — recommended:** PaneHeader supplies its actual `accented` boolean to render-function slots. Callers stop independently deciding background state. This fixes raw-terminal TAIL and the surface badge without duplicating the completion-setting subscription in each caller.

All five recommendations remain UNCONFIRMED. This is a requested plan, not permission to implement. If the owner wants the global Frost hue untouched, the bounded alternative is the same redesign with an explicitly accepted 3.827:1 Frost-light exception. That alternative does NOT meet an “all shipped pairs at least 4.5:1” acceptance criterion; choose it knowingly, not by omitting the failed row from the table.

## Exact visual and code design

### One accented row, two paint states

Keep `statusLit` working-only and keep `data-status-lit` with its current meaning. Keep the running-agent exclusion based on `isSessionLive`, including when Status Mode is off. Do not substitute `sessionIsWorking` or alter acknowledgment semantics here.

Inside PaneHeader derive `accented = statusLit || completionStriped`. Use this for the existing foreground/background branch:

```tsx
accented ? 'bg-accent text-accent-fg' : 'bg-surface text-muted'
```

Add `data-header-accented` if needed by renderer tests/debugging; do not relabel completion as “status lit.” Keep `.pane-header-completion-stripes` and `data-completion-striped` for the patterned state only. An unseen completion can never have both `data-status-lit=true` and `data-completion-striped=true`.

Replace the existing stripe declaration with this exact candidate CSS:

```css
/* The row itself is the plate. Both bands are opaque accent tones so path
   length cannot erase the signal, and all foreground uses the working
   bar's accent-fg. 15% black is bounded by the darkest shipped accent's
   text contrast; do not increase it without rerunning the palette matrix.
   --theme-accent is the same source that bg-accent binds to via @theme inline. */
.pane-header-completion-stripes {
  background-image: repeating-linear-gradient(
    90deg,
    var(--theme-accent) 0 8px,
    color-mix(in srgb, var(--theme-accent) 85%, #000000) 8px 12px
  );
}
```

There is no `transparent` stop, opacity, animated offset, overlay, mask, text shadow, or new border on the status row. Keep a real `bg-accent` under the image, so the paint does not depend on the surrounding surface. Apply the image to the status ROW only, not the outer header wrapper. The outer wrapper retains its current surface foreground/background for other rows.

The whole full-accent band is unchanged from the working fill. The word “darker” applies only to the secondary 4px band; this is not the old 45%-strength activity stripe.

### Text, plates, and the complete slot audit

| Content | Plain surface row | Solid working OR patterned completion row | Change |
|---|---|---|---|
| Pane-label chip | Inherited `text-muted`; current border | Inherited `text-accent-fg`; `border-current/30` | No opaque fill; preserve chip shape/metrics |
| Path including ellipsis | Inherited `text-muted` | Inherited `text-accent-fg` at full opacity | Preserve `.truncate-start`, title tooltip, inner `dir="ltr"` |
| `raw {provider}` badge | `text-ink` | Inherit `accent-fg` | AgentTerminalLeaf currently keys only on `statusLit`; move to header-provided `accented` |
| Raw-agent TAIL | `text-accent` | Inherit `accent-fg` | Otherwise TAIL disappears on full-accent bands |
| Raw-agent `terminal view` | Inherit `text-muted` | Inherit `accent-fg` | Already inherits; preserve `hidden @min-[320px]:inline` and 9px size |
| Shell command / `terminal` badge | `text-ink` | Inherit `accent-fg` when working | Migrate same slot API for consistency; shells still never complete-stripe |
| Shell TAIL | `text-accent` | Inherit `accent-fg` when working | Preserve behavior through shared API |
| Title/name row, name badge | Its existing `text-ink` on canvas | Same | Not part of the painted status row |
| Routing-gap row / refresh button | Existing warning text / inherited warning | Same | Not a header slot; do not recolor through a broad descendant selector |

The feed view's ScrollIndicator TAIL/worktree badges are below the feed, not PaneHeader slots, and must not be changed. The raw terminal transcript-error banner is likewise outside this row. These are all production badge/trailing inputs to this shared component at the inspected revision.

In `PaneHeader.tsx:161–189`, delete the plate WHY comment, `data-completion-plate`, `pane-header-completion-plate`, `-mx-1.5`, `px-1.5`, and the wrapper's `rounded-chip`. Retain a neutral identity wrapper with `flex min-w-0 items-center gap-2`; it groups the truncating path without painting anything. Do not remove the pane label's own `rounded-chip`/padding/border.

In `PaneHeader.tsx:203–216`, remove the inner trailing plate span entirely. Render the resolved trailing slot directly in the existing `ml-auto flex flex-shrink-0 items-center gap-2 pl-1` wrapper. Delete the plate CSS and its obsolete comment at `styles.css:1181–1193`. Update the top-level PaneHeader comment that still describes plates.

For both slot props use the concrete contract `ReactNode | ((state: { accented: boolean }) => ReactNode)`. PaneHeader resolves functions from its own computed `accented` value and still accepts static nodes used by current tests/simple callers. Resolve trailing before deciding whether to render its wrapper, so a callback returning `null` does not allocate a phantom slot. Render functions are formatting callbacks, not components; callers must not call hooks inside them.

In both terminal leaves, use `badge={({ accented }) => ...}` / `trailing={({ accented }) => ...}` and replace `statusLit ? '' : 'text-ink'` / `statusLit ? '' : 'text-accent'` with the same branches on `accented`. Remove those leaves' `paneHeaderStatusLit` import and local `statusLit` computation. Retain the helper module/function for PaneHeader and its recorded-runtime test consumer. Rewrite its comment: it owns working-fill eligibility, not every possible painted header background.

### Geometry and status-mode behavior

| State | Status Mode ON | Status Mode OFF |
|---|---|---|
| Running, regardless of stale unread | Solid accent; `accent-fg` | Plain surface; ordinary text |
| Not running + unseen + completion setting on | Patterned accent; `accent-fg` | Patterned accent; `accent-fg` |
| Seen or completion setting off, not running | Plain surface | Plain surface |
| Shell | Existing working/plain behavior, never patterned | Plain surface, never patterned |

For every transition within a given mode, keep identical DOM layout and vertical metrics. Only color/background-image changes. Row remains `flex items-center justify-between text-[10px]`, unpadded, with `min-h-[5px]` when mode is on. Content group remains `@container flex flex-1 items-center gap-2 min-w-0 px-3`, using `py-0` on and `py-1` off. No forced 5px height, new clipping, or hidden label. Off-mode completion is the full taller header plate, not a 5px stripe above or below it.

The 12px horizontal repeat is independent of row height, so it still exists if a future textless row really is 5px high. Horizontal banding with a taller period can collapse visually to a single color in that case, which is why vertical is preferred.

Color flag stays the final sibling: `w-1/4 flex-none self-stretch border-l border-canvas`, its existing raw flag color, tooltip and `aria-hidden`. It opaquely owns the right quarter of both solid and patterned rows. The content/pattern gets the remaining three quarters; unflagged headers get all the width. Keep row padding at zero so the quarter is a true quarter. No absolute overlay or text on the flag. A 1px canvas seam still separates matching accent/flag hues.

Do not add `overflow-hidden` to the entire row to conceal slot layout mistakes. Keep start truncation on the path, the shrinking identity group, the fixed trailing slot, and the 320px text-container query. Check narrow flagged panes with the longest provider badge. Existing behavior at arbitrarily tiny widths is not a promise that fixed labels can fit in zero space.

Keep AgentTitleHeader and the routing-gap row as siblings after the patterned row. Completion appearance/clear must not add/remove either, alter the reserved name row, or resize the PTY. Changing Status Mode can still change height by 8px as it does today; changing completion must not.

## Contrast: hypothesis tested against the actual palette

Text is 9–10px, so the normal-text **4.5:1** threshold applies, including the semibold chip; the large-text exception does not apply. Use unrounded values for pass/fail. [W3C contrast criterion](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

Method: parse the actual `ACCENTS` table, follow `applyTheme` family selection and the CSS aliases/overrides described above, and compute sRGB channel mixing before linearization. For normalized channel `c`, linearize as `c/12.92` for `c <= 0.04045`, otherwise `((c + 0.055)/1.055)^2.4`. Luminance is `0.2126R + 0.7152G + 0.0722B`; ratio is `(lighter + 0.05)/(darker + 0.05)`. Tone B's encoded sRGB channels are `0.85 * toneA`; no intermediate 8-bit rounding. [W3C luminance definition](https://www.w3.org/WAI/WCAG22/Understanding/relative-luminance.html), [CSS color-mix model](https://www.w3.org/TR/css-color-5/#color-mix).

**Result:** the hypothesis is valid for seven accents in every built-in theme, and Frost in all four dark themes. It is false as a universal claim with the current tokens: Frost light already fails on the FULL accent, independent of the choice of second tone. Dark-foreground accents are safe with the proposed 15% black mixture; their limiting case is Coral at 5.268:1.

### Current tokens, proposed pattern: all 48 accent/theme pairs

Each ratio below compares the current `accent-fg` against A (full accent) or B (85% accent + 15% black). This is computed evidence, not a claim that the changed UI has been rendered. These ratios apply identically with the high-contrast setting off/on, giving 96 covered built-in configurations. `FAIL` is a full-band failure; all second-band values pass.

| Theme | Accent | A (current full accent) | Current accent-fg | vs A | vs B | Result |
|---|---|---|---|---:|---:|---|
| Nord (`dark-nord`) | Frost | `#88c0d0` | `#171b21` | 8.639 | 6.274 | Pass |
| Nord (`dark-nord`) | Lime | `#7dd3a0` | `#0a0a0a` | 11.028 | 7.964 | Pass |
| Nord (`dark-nord`) | Amber | `#ff9f4a` | `#0a0a0a` | 9.720 | 7.060 | Pass |
| Nord (`dark-nord`) | Magenta | `#e66ed9` | `#0a0a0a` | 7.162 | 5.292 | Pass |
| Nord (`dark-nord`) | Gold | `#f5d64a` | `#0a0a0a` | 13.764 | 9.846 | Pass |
| Nord (`dark-nord`) | Coral | `#ff6b6b` | `#0a0a0a` | 7.134 | 5.268 | Pass |
| Nord (`dark-nord`) | Lavender | `#b5a3ff` | `#0a0a0a` | 9.095 | 6.635 | Pass |
| Nord (`dark-nord`) | Sky | `#6bb6ff` | `#0a0a0a` | 9.202 | 6.705 | Pass |
| Dark (`dark`) | Frost | `#88c0d0` | `#171b21` | 8.639 | 6.274 | Pass |
| Dark (`dark`) | Lime | `#7dd3a0` | `#0a0a0a` | 11.028 | 7.964 | Pass |
| Dark (`dark`) | Amber | `#ff9f4a` | `#0a0a0a` | 9.720 | 7.060 | Pass |
| Dark (`dark`) | Magenta | `#e66ed9` | `#0a0a0a` | 7.162 | 5.292 | Pass |
| Dark (`dark`) | Gold | `#f5d64a` | `#0a0a0a` | 13.764 | 9.846 | Pass |
| Dark (`dark`) | Coral | `#ff6b6b` | `#0a0a0a` | 7.134 | 5.268 | Pass |
| Dark (`dark`) | Lavender | `#b5a3ff` | `#0a0a0a` | 9.095 | 6.635 | Pass |
| Dark (`dark`) | Sky | `#6bb6ff` | `#0a0a0a` | 9.202 | 6.705 | Pass |
| Gray Dark (`dark-dim`) | Frost | `#88c0d0` | `#171b21` | 8.639 | 6.274 | Pass |
| Gray Dark (`dark-dim`) | Lime | `#7dd3a0` | `#0a0a0a` | 11.028 | 7.964 | Pass |
| Gray Dark (`dark-dim`) | Amber | `#ff9f4a` | `#0a0a0a` | 9.720 | 7.060 | Pass |
| Gray Dark (`dark-dim`) | Magenta | `#e66ed9` | `#0a0a0a` | 7.162 | 5.292 | Pass |
| Gray Dark (`dark-dim`) | Gold | `#f5d64a` | `#0a0a0a` | 13.764 | 9.846 | Pass |
| Gray Dark (`dark-dim`) | Coral | `#ff6b6b` | `#0a0a0a` | 7.134 | 5.268 | Pass |
| Gray Dark (`dark-dim`) | Lavender | `#b5a3ff` | `#0a0a0a` | 9.095 | 6.635 | Pass |
| Gray Dark (`dark-dim`) | Sky | `#6bb6ff` | `#0a0a0a` | 9.202 | 6.705 | Pass |
| Tokyonight (`dark-tokyonight`) | Frost | `#88c0d0` | `#171b21` | 8.639 | 6.274 | Pass |
| Tokyonight (`dark-tokyonight`) | Lime | `#7dd3a0` | `#0a0a0a` | 11.028 | 7.964 | Pass |
| Tokyonight (`dark-tokyonight`) | Amber | `#ff9f4a` | `#0a0a0a` | 9.720 | 7.060 | Pass |
| Tokyonight (`dark-tokyonight`) | Magenta | `#e66ed9` | `#0a0a0a` | 7.162 | 5.292 | Pass |
| Tokyonight (`dark-tokyonight`) | Gold | `#f5d64a` | `#0a0a0a` | 13.764 | 9.846 | Pass |
| Tokyonight (`dark-tokyonight`) | Coral | `#ff6b6b` | `#0a0a0a` | 7.134 | 5.268 | Pass |
| Tokyonight (`dark-tokyonight`) | Lavender | `#b5a3ff` | `#0a0a0a` | 9.095 | 6.635 | Pass |
| Tokyonight (`dark-tokyonight`) | Sky | `#6bb6ff` | `#0a0a0a` | 9.202 | 6.705 | Pass |
| Light (`light`) | Frost | `#5e81ac` | `#faf9f6` | 3.827 | 5.022 | **FAIL A** |
| Light (`light`) | Lime | `#2f6f46` | `#faf9f6` | 5.726 | 7.206 | Pass |
| Light (`light`) | Amber | `#8a470b` | `#faf9f6` | 6.678 | 8.248 | Pass |
| Light (`light`) | Magenta | `#8b247f` | `#faf9f6` | 7.508 | 9.147 | Pass |
| Light (`light`) | Gold | `#735905` | `#faf9f6` | 6.312 | 7.845 | Pass |
| Light (`light`) | Coral | `#9f2929` | `#faf9f6` | 7.065 | 8.689 | Pass |
| Light (`light`) | Lavender | `#5a43b4` | `#faf9f6` | 6.886 | 8.467 | Pass |
| Light (`light`) | Sky | `#1f5eaa` | `#faf9f6` | 6.157 | 7.686 | Pass |
| Soft Light (`light-soft`) | Frost | `#5e81ac` | `#faf9f6` | 3.827 | 5.022 | **FAIL A** |
| Soft Light (`light-soft`) | Lime | `#2f6f46` | `#faf9f6` | 5.726 | 7.206 | Pass |
| Soft Light (`light-soft`) | Amber | `#8a470b` | `#faf9f6` | 6.678 | 8.248 | Pass |
| Soft Light (`light-soft`) | Magenta | `#8b247f` | `#faf9f6` | 7.508 | 9.147 | Pass |
| Soft Light (`light-soft`) | Gold | `#735905` | `#faf9f6` | 6.312 | 7.845 | Pass |
| Soft Light (`light-soft`) | Coral | `#9f2929` | `#faf9f6` | 7.065 | 8.689 | Pass |
| Soft Light (`light-soft`) | Lavender | `#5a43b4` | `#faf9f6` | 6.886 | 8.467 | Pass |
| Soft Light (`light-soft`) | Sky | `#1f5eaa` | `#faf9f6` | 6.157 | 7.686 | Pass |

### Recommended Frost-light correction

| Theme | New A | Foreground (unchanged) | New B, exact encoded RGB | Foreground vs A | Foreground vs B |
|---|---|---|---|---:|---:|
| Light | `#507097` | `#faf9f6` | `rgb(68 95.2 128.35)` | 4.858 | 6.226 |
| Soft Light | `#507097` | `#faf9f6` | `rgb(68 95.2 128.35)` | 4.858 | 6.226 |

All other entries remain as above. With this explicitly proposed palette adjustment, all 48 built-in combinations clear 4.5:1 on both tones, including high-contrast variants. It also fixes the solid working fill. Setting the current Frost foreground to pure white is insufficient (its full-accent contrast is below 4.5:1); this cannot be fixed by making the existing off-white slightly whiter.

CSS pre-apply fallbacks are separate from applied themes: `:root` is Nord/Frost with the dark ratios above; `[data-mode="light"]` defines the light pair and should be updated alongside ACCENTS. `light-soft` does not define its own accent pair before runtime override and falls through to `:root`; the real `applyTheme` writes its light-family pair. Do not invent a missing CSS light-soft accent override when calculating runtime values.

Saved/extension themes apply their own `accent` and `accentFg`, can contain arbitrary CSS colors/alpha, and ignore the built-in accent picker. There is no finite “every custom theme” table. Use their actual tokens for the pattern; do not overwrite their palettes, infer text color from theme name, or claim their contrast is guaranteed. The shipped sparse-theme Nord fallback passes. A custom pair already below 4.5, or a dark-text custom accent just above it that fails after darkening, remains a real limitation to document and visually inspect with available user themes. Automatic palette repair and a new theme-validation subsystem are out of scope.

## Concrete change list (line numbers at inspected HEAD)

1. `src/renderer/src/workspace/tile-tree/TileLeaf/PaneHeader.tsx:20–27, 76–80, 87–113, 161–217`: rewrite plate rationale; add slot render contract and one accented presentation derivation; use accented colors for both paint states; remove plate painting/padding/offsets; preserve neutral grouping and geometry. Correct the stale second-row comment at `221–226` while touching this area.
2. `src/renderer/src/styles.css:1150–1193`: replace old transparent-gap pattern with the exact two-tone gradient and WHY comment; delete plate class/comment. No animation or new theme-specific pattern selectors.
3. `src/renderer/src/workspace/tile-tree/AgentTerminalLeaf.tsx:20, 593–595, 643–680`: remove local working-only slot color derivation; make raw-provider badge and TAIL use the header's `accented` state; preserve terminal-view text/container query. Update comment explaining why completion now shares foreground treatment.
4. `src/renderer/src/workspace/tile-tree/TerminalLeaf.tsx:24, 626–628, 682–692`: migrate its command badge and TAIL to the same render-slot contract; no completion opt-in. No terminal lifecycle changes.
5. `src/renderer/src/workspace/tile-tree/TileLeaf/paneHeaderStatus.ts:1–12`: fix the ownership comment; leave `paneHeaderStatusLit(statusMode, isSessionLive)` implementation/meaning unchanged. `TileLeaf.tsx:804–812` remains wired exactly as it is.
6. `src/renderer/src/app-state/settings/types.ts:128–146` and `src/renderer/src/styles.css:553`: recommended Frost-light palette correction only, plus the ACCENTS comment that currently calls light Frost exact nord10. Do not edit `DEFAULT_SETTINGS.showStatusMode` or any saved user palettes. This item must be explicitly visible in the eventual PR scope.
7. `src/renderer/src/app-state/settings/theme.renderer.test.ts:92–95`: update the intentional Frost-light expectation; cover both light themes and assert foreground too. Add contrast regression coverage described below. `theme.ts` runtime architecture needs no change.
8. `PaneHeaderColorFlag.tsx:26–28`: comment-only correction of the claimed ~5px height; no flag class/DOM changes. Correct the same claim in the affected color-flag test comment if touched.
9. Tests listed below. Keep old plans as history; the eventual branch plan/PR explains why #1192's plates were superseded. Do not rewrite the earlier user agreement as though this design had already been approved.

## Tests

These are implementation requirements, not tests run by this planning agent.

1. **Update `TileLeaf/PaneHeader.completionStripes.renderer.test.tsx`.** Preserve all existing state/setting/running/shell cases. Replace the plate-presence test with a long-path regression derived from the supplied screenshot (pane label B6 and its displayed agent-code path; normalize personal path segments in the fixture). Assert completion and working both use the accented row presentation, the path/label have no surface plate ancestors, and completion has the pattern with `data-status-lit=false`. Exercise on/off Status Mode, clearing unread, setting off, and beginning a new turn with stale unread. Current code fails the accented completion / no-plate assertions. Keep a static-node slot case and a render-slot case, including callback-returning-null.
2. **Extend `AgentTerminalLeaf.statusHeader.renderer.test.tsx`.** Its mocked settings currently omit `showAgentCompletionIndicator`; explicitly enable it in the completion cases. Mount with real leaf slot markup, an idle runtime holding an unread marker, Tail active, and focus false (or controlled timers) so the dwell does not clear the fixture before assertions. Assert `raw <provider>`, TAIL, and terminal-view text all receive the actual accented presentation. Then clear the marker and toggle the completion setting without remounting the leaf: ordinary badge/TAIL colors return. Run with Status Mode off as well as on. The original caller retains `text-ink` / `text-accent` on completion and fails. Existing xterm mocks are appropriate external-edge doubles; no live PTY is needed to check slot wiring.
3. **Extend `TerminalLeaf.header.renderer.test.tsx`.** Keep shell working/plain badge and TAIL colors correct through the new slot API. Explicitly enable the completion setting and populate shell unread state; still no completion pattern. This guards accidental widening of the shared signal.
4. **Extend `workspace/dispatch/DispatchColorFlags.renderer.test.tsx`.** Add completion to the existing flagged/unflagged and mode padding cases. The flag remains last, 25%, solid, bordered, stretched, and independent of completion. Keep the `@container` / inner-padding contract. Assertions on class/DOM contracts are useful here but do not establish actual pixel layout.
5. **Add `TileLeaf/PaneHeader.completionContrast.test.ts` (unit).** Read the production stylesheet, resolve the actual two gradient tones and mix weight, and import `ACCENTS`/`THEME_MODES` for all shipped pairs. Use the WCAG formula to assert both tones meet 4.5:1. Do not duplicate the preset table or 85% blend as a disconnected test implementation; the test must fail if the production mix weight changes. Existing `settings/nordTheme.test.ts` demonstrates the repository's limited CSS-block-reading convention. Document that only this deliberately simple gradient grammar is supported; unexpected syntax fails clearly, not silently skipped. With the recommended Frost correction reverted, Light/Soft Light Frost fail at 3.827:1. With a materially darker mix (e.g. 65% accent), dark Coral/Magenta should fail, proving the test protects the proposed contrast constraint.
6. **Theme integration:** `settings/theme.renderer.test.ts` checks actual `applyTheme` output for Frost in both light themes, default dark Frost unchanged, and switching accents/themes. The contrast unit checks token arithmetic; it cannot replace verifying which tokens the runtime writes. Include CSS light fallback in the contrast check so first-paint values do not drift from the corrected preset.
7. **Run existing boundary suites:** `PaneHeader.phoneCoupling.renderer.test.tsx`, `PaneHeader.routingGap.renderer.test.tsx`, `features/workspace/ui/AgentTitlePrompt.renderer.test.tsx`, `TileLeaf/useAcknowledgeAfterDwell.renderer.test.tsx`, and relevant agent-name reservation tests. No new store-key assumptions, title-row coupling, or seen semantics should result from this presentation change.

The state inputs are justified finite UI cases grounded in the existing regression suites and screenshot, not fabricated provider transcripts. Do not invent a PTY recording to test a background-image bug. After implementing, demonstrate the visual regression assertions fail when the plate/presentation fix is reverted, restore the fix, and rerun. Demonstrate the contrast failure separately by reverting only the Frost correction.

## Verification and visual acceptance

Planning verification completed: source/history/screenshot inspected; all 48 current accent/theme pairs computed from repository values; proposed Frost correction computed; current settings and geometry assumptions checked against code. No app was launched and no source/test implementation was changed. No claim of rendered visual success is made.

For implementation, first run the scoped renderer suites above via `npm run test:renderer -- <test-paths>` and the contrast unit via `npm run test:unit -- <test-path>`, then `npm run typecheck`. The repository's full gate is `npm run check`, but it includes system tests that can launch Electron. **Do not run that gate while this brief's no-Electron instruction remains in force.** Report it as unrun; use normal CI/later authorized verification for the complete gate. Do not quietly substitute a green happy-dom result for visual verification.

The renderer project uses happy-dom, which cannot validate real flex widths, typography, container-query layout, or background-image painting. Before calling the redesign visually accepted, inspect actual component markup with compiled production CSS in an isolated browser fixture (not the app/Electron), or have the owner inspect an existing app instance in a separately authorized session. Do not claim either was done here. If neither is available under the implementation constraints, deliver screenshots/visual acceptance as explicitly pending.

Visual matrix / measurable acceptance:

- Both status modes; working, unseen-complete, seen, and setting-disabled states. Completion transitions change no status-row height, path inset, chip position, title-row height, or terminal viewport rectangle. Mode toggling retains the intentional 8px padding difference.
- Source-screenshot long path/B6 first, then a short path, no path, and narrow widths around 200/250/320/480px plus a wide pane. For the 320px container query, measure the text group's width, not whole pane width; the flag reserves a quarter.
- Feed and raw terminal surfaces; TAIL on/off; a longest supported provider badge; flag absent/present; same-hue flag/accent. A long path must not cover the pattern. TAIL cannot vanish on any full-accent band. Text must stay left of the flag at supported pane widths.
- Title absent, title present, reserved name row, and late name arrival. Pattern appears only in the first row; title/name/routing-warning backgrounds and foregrounds remain unchanged. No new PTY resize on completion appearing/clearing.
- All eight accents in all six built-ins, high contrast on/off. Prioritize dark Coral/Magenta (lowest shaded-band text contrast) and both light Frost variants (palette change). Compare patterned and solid rows side by side at 100% and 200% zoom. The numbers establish text contrast, not perceived ease of reading a small glyph crossing bands or the perceptual strength of the completion signal.
- At least one saved theme with dark `accentFg` and one with light `accentFg`, if real saved themes are available. Record their actual contrast; do not claim universal custom-theme compliance from built-in results.
- Raster/pixel evidence should sample background between glyphs and inspect text color separately; anti-aliased glyph pixels are not the WCAG foreground definition. No surface-colored center island except the intentional solid right-quarter flag.

## Risks and rejected options

- **Global Frost-light change:** recommended to make the universal contrast claim honest, but affects links, focus rings, selected controls, and working headers in those themes. Review those surfaces and the theme picker as part of visual acceptance. The contrast problem predates this redesign; do not describe it as a regression caused by the new bands. If retained unchanged, report the known exception explicitly.
- **Dark foreground is common, not an edge case:** every shipped dark accent uses dark `accent-fg`, with Frost using `#171b21` and the other seven `#0a0a0a`. Stronger darkening would eat into the margin. The bounded 15% mix is chosen from those actual values, not a blanket assumption that dark-theme text must be white.
- **Raw terminal:** changing only PaneHeader leaves the caller's TAIL/raw-provider color wrong. Shared render-slot state fixes the ownership issue; duplicating the completion predicate in AgentTerminalLeaf is rejected because it would create another settings-dependent source of truth.
- **Title row:** applying the pattern/foreground on the outer header would recolor the second row or warnings, and altering reserved-row logic can resize the terminal mid-turn. Keep the painted scope at `data-pane-header-row`.
- **Keep or shrink plates:** rejected. Shrinking to fit text still masks a long path, and moves the problem between pane widths. Text belongs on the bar.
- **Full accent + transparent/surface gaps:** rejected. It recreates the incompatible-background problem that prompted plates; accent-fg is not selected for surface contrast.
- **Dim the whole pattern / return to 45% accent:** rejected by the owner's full activity-color requirement. Full 8px bands must stay the same token as the working bar.
- **Mix 15% toward accent-fg everywhere:** rejected on measured evidence: current light Lime becomes 4.178:1 and light Sky 4.489:1; Frost gets worse still. Theme-independent `#000` mixing is safe for all the proposed corrected built-ins and simpler than branching on theme names.
- **Lighten dark themes / darken light themes:** viable, but adds polarity handling without necessity; all current dark foregrounds safely tolerate this plan's small darkening. Lightening also reduces pattern distinction on already bright accents such as Gold. Arbitrary saved-theme polarity cannot be inferred from `data-mode="custom"`.
- **Change only Frost-light text to dark:** viable with a different, lightened Frost secondary tone, but introduces accent-specific pattern handling and changes foreground polarity. Recommended correction keeps one pattern formula, the off-white foreground, and both bar states in the same family.
- **Make all working bars solid with Status Mode off:** rejected as an unrelated preference change. Independent completion settings are intentional and tested.
- **Horizontal stripes, thin border-only marker, or stripes only after the text:** rejected as the default. Horizontal stripes lose pattern at shallow heights; border-only/free-space patterns stop making the row itself the shared plate and can disappear with a long path.
- **Text shadow/outline, animation, or a new second completion row:** rejected. Shadows blur tiny text; animation adds unnecessary attention; a new row changes geometry and terminal size.

## Out of scope

Unread classification, dwell timing, focus/engagement semantics, provider activity derivation, shell completion indicators, terminal lifecycle, title/name reservation behavior, new settings/default changes, automatic custom-palette repair, and app launch. No new issue/PR was created in this planning-only session; the parent can link the eventual accepted design to the existing completion history and record the separate pre-existing Frost contrast finding according to repository conventions.
