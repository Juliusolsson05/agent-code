# UI primitive theme fidelity — plan

**Date:** 2026-07-28
**Branch:** `feat/ui-primitives-theme-fidelity`
**Status:** plan, then implementation in the same PR

## The finding

`src/renderer/src/components/ui/` disagrees with itself about which theme tokens
a control is made of.

`NumberInput` (`number-input.tsx`, the most recently added primitive) is built
entirely on the `control-*` family:

```
container  border-control-border bg-control-bg
steppers   text-control-fg hover:bg-control-hover-bg hover:text-ink
           disabled:hover:bg-control-bg
field      text-control-fg
```

`Button` (`button.tsx`) is not. Its `outline` variant hardcodes the tokens that
`control-*` happens to *alias to*, rather than the `control-*` tokens
themselves:

| `Button` variant `outline` | what the app's control chrome uses |
| -------------------------- | ---------------------------------- |
| `border-border`            | `border-control-border`            |
| `bg-transparent`           | `bg-control-bg`                    |
| `text-ink-dim`             | `text-control-fg`                  |
| `hover:border-border-hi`   | `hover:border-control-border-hover`|
| *(no hover background)*    | `hover:bg-control-hover-bg`        |

`ghost` has the same problem in miniature: it already reaches for
`hover:bg-control-hover-bg`, but pairs it with `text-ink-dim` instead of
`text-control-fg`. So a single `DialogActions` footer renders a `ghost` Cancel
on `ink-dim` next to a `NumberInput` stepper on `control-fg` — two different
token families, one control strip.

### Why this is invisible today

`styles.css` aliases the whole family to exactly those values:

```css
--theme-control-bg: transparent;
--theme-control-hover-bg: var(--theme-surface-hi);
--theme-control-border: var(--theme-border);
--theme-control-border-hover: var(--theme-border-hi);
--theme-control-fg: var(--theme-ink-dim);
```

Under every built-in theme the two columns above render identically. Nothing
looks wrong, which is why this survived.

### Why it is a real bug anyway

`customAppearance.ts` exposes all seven `control-*` tokens as independently
user-editable, and documents them as being about buttons specifically:

```
controlBg          'Resting button/toggle/select background.'
controlBorder      'Resting control border.'
controlFg          'Resting control text/icon color.'
controlBorderHover 'Hover/focusable control border before true focus.'
```

`theme.ts` → `applyCustomAppearance()` writes every one of them as an inline
custom property on `<html>`, where they outrank the `[data-mode]` blocks.

So the moment a user edits `controlBg`, `controlFg`, or `controlBorder`:

- the 25 hand-rolled `control-*` buttons in the tree honour it;
- `NumberInput` honours it;
- **every `<Button>` in the app silently ignores it.**

The primitive is currently *less* theme-correct than the ad-hoc markup it
exists to replace. That is also the most plausible reason adoption stalled:
`Button` is not a drop-in for the app's most common button, so nobody could
migrate onto it without changing how their feature looked under a custom theme.

**This inverts the obvious remediation order.** Migrating call sites onto
`Button` first would spread the defect across the tree. `Button` gets fixed
first; migration follows.

## Audit numbers (against `main`, commit `6506b9aa`)

Counted across the desktop renderer, `providers/*/renderer`, and
`remote-client`.

| Measure | Count |
| --- | --- |
| Raw `<button>` in the renderer | 213 |
| — carrying tokens matching an existing variant | 177 (83%) |
| — genuinely bespoke (tab strips, segmented controls, chips) | 29 |
| — unstyled | 7 |
| Hand-rolled `control-*` button recipe | 25 sites / 11 files |
| Files importing `Button` | 17 |

Bucketed by the tokens each raw button carries: 77 outline-shaped, 52
ghost-shaped, 31 accent-shaped, 17 danger-shaped. "Shaped like" means *carries
those tokens*, not *verified drop-in* — the bespoke bucket exists because
segmented controls and tab strips legitimately are not `Button`s.

### Clean, and worth recording so nobody re-audits it

- Colour discipline is strong: 9 raw Tailwind palette colours app-wide, all in
  debug modules. Zero `bg-[#...]` arbitrary values.
- `components/ui/` structure is fully README-compliant: flat, kebab-case, no
  barrel, no nested taxonomy.
- Exactly one `fixed inset-0` outside `dialog.tsx`; no `createPortal` outside
  Radix.
- The provider renderers are the best-behaved surface in the codebase — all
  provider modals use `Dialog` + `Button` with zero raw buttons.
- `remote-client` shares no primitives with the desktop renderer. It is a
  separate Vite build using plain CSS classes, deliberately, for touch targets.
  Out of scope here; noted so the next audit does not re-derive it.

## Scope

Three defects, in dependency order. Everything else found by the audit is
recorded above and deliberately left alone.

### 1. Retokenize `Button` onto `control-*`

`outline` and `ghost` point at the `control-*` family. `default`,
`destructive`, and `link` are unchanged — they are accent/danger chrome, not
control chrome, and have no `control-*` equivalent.

`secondary` is also unchanged. It is the filled/raised treatment
(`bg-surface-hi text-ink`) and there is no `control-*` token for "raised
resting" — `controlActiveBg` means *selected*, which is a different state.
Forcing it would be inventing a meaning the theme schema does not have.

**Accepted visual change:** `outline` gains `hover:bg-control-hover-bg`. Under
default themes that is `surface-hi`, i.e. the same hover fill the 25
hand-rolled control buttons already paint. This makes step 3 a convergence
rather than a second divergence.

### 2. `DictationGuideModal` → `DialogContent`

The only remaining hand-rolled app modal. It implements its own Escape handler,
its own Tab focus trap, its own `fixed inset-0` backdrop, its own focus
restoration, and copies `data-agent-code-interaction-owner="app"` onto its
root.

The `components/ui/README.md` forbids each of these by name:

> Feature modals must not add their own document-level Escape listener, focus
> trap, backdrop implementation, or background-input suppression.

> Do not copy the marker into feature dialogs. The primitive owns it for
> exactly the same lifetime as its portal and focus trap.

It is not one of the sanctioned full-screen takeovers (setup, new-agent
placement). Its footer also becomes `DialogActions`, which is what the rest of
the tree uses.

### 3. Text inputs onto `Input`

Three competing recipes exist for one control:

| Site | Recipe |
| --- | --- |
| `components/ui/input.tsx` | `border-input-border bg-input-bg` + `focus-visible:border-input-border-focus` + ring |
| `SettingsSearch.tsx` | hand-copy of the above, minus the ring |
| `DictationApiKeyRow.tsx` | **`control-*` tokens on a text input** — wrong family |

`DictationApiKeyRow` is the substantive one: `control-*` is button chrome,
`input-*` is field chrome, and the two are independently themeable.

### 4. Migrate the hand-rolled `control-*` buttons

The 25 sites in 11 files, onto `<Button variant="outline">` / `"ghost"`. This
is only safe *after* step 1; before it, each migration is a silent regression
under custom themes.

Sites that are toggles with a selected state keep their conditional class —
`Button` has no `aria-pressed` variant and inventing one for this is out of
scope.

## Explicitly out of scope

- The other ~150 raw buttons. `components/ui/README.md` says directly: *"No
  migration of every existing button as a prerequisite."* Most are tab strips
  and segmented controls where `Button` is not a drop-in.
- New primitives (checkbox ×5, radio ×4, `<select>` ×2 have ad-hoc
  implementations and each now clears the README's "real consumer" bar). Worth
  a follow-up; not this PR.
- `remote-client` chrome.

## Verification

Per `docs/testing/`: `electron-vite build` and `vitest` do not type-check, so
raw `tsc` runs on both projects are the gate.

1. `npx tsc -p tsconfig.node.json --noEmit`
2. `npx tsc -p tsconfig.web.json --noEmit`
3. `npm run test:renderer` — `dialog.renderer.test.tsx` covers the modal
   contract step 2 hands to Radix.
