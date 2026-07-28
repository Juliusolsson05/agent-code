# Dictation Mouse Trigger Implementation Plan

> **Status: SHIPPED** (PR #616). Two things this plan got WRONG were found in
> review and by a hardware probe, and the merged code differs from the task
> bodies below. Read this section before trusting any code block here.
>
> 1. **`beginDictationHold` needs a re-entrancy guard.** The plan assumed one
>    ownership slot was sufficient for two triggers. It is not: a second
>    `begin` while a hold is outstanding could capture a *different* target
>    (pickTarget prefers the focused pane), start a second recorder and orphan
>    the first one's microphone forever — and it reset the hold clock, so a
>    stray click during a live dictation measured as a sub-180 ms tap and
>    discarded the whole recording.
> 2. **The release edge must test `event.buttons`, not `event.button`.** For a
>    mouse there is ONE pointer, so `pointerup` fires only when the last button
>    is released and carries whichever button that was. "Hold middle, click
>    left, release middle, release left" never produces a `pointerup` for
>    middle. The plan's `event.button !== boundButton` guard dropped that
>    release and left the mic open. Down likewise needs `mousedown` as well as
>    `pointerdown`, since pressing the bound button while another is held emits
>    no `pointerdown` at all. Confirmed against real hardware — see
>    `MOUSE_BUTTON_MASKS` in `lib/mouseBinding.ts` for the captured evidence.
>
> Also corrected post-plan: `coerceMouseButtonBinding` used `in` (walks the
> prototype chain, so `'toString'` coerced to itself) and now uses
> `Object.hasOwn`; the terminal overlay's instruction text no longer sniffs
> `dictationShortcut` for `'Fn'` (wrong for a bare `Cmd` native hold, and blind
> to the mouse trigger) and instead reads the registry's active hold style.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user hold a mouse button — middle, or either side button — to dictate into the focused Agent Code composer or terminal, releasing to transcribe.

**Architecture:** `dictationHotkeyRegistry.ts` is already the single dispatcher for dictation triggers: it picks the target (focused pane, else most-recently-focused), remembers which target consumed the press so the release reaches the same one, and gates on `hasAppInteractionOwner()`. This feature adds **one new input source feeding that existing registry** — a window-level pointer listener in the renderer — rather than a second dictation path. Everything downstream (hold-to-talk lifecycle, the 180 ms accidental-tap discard, mic pre-warm, composer-vs-terminal sink) is reused unchanged.

**Tech Stack:** TypeScript, React 18, Zustand (`app-state/settings`), DOM Pointer Events. No main-process code, no native code, no new dependency.

## Global Constraints

- **No new test files in this PR.** Standing repo preference: feature/fix PRs do not add test files or wire new `test:*` scripts; a test-cleanup PR is planned separately. Verification for every task below is therefore `tsc` + the existing suite staying green, not new specs. Where a behavior *would* deserve a test, the task says so explicitly so the cleanup PR has the list.
- **Left (button 0) and right (button 2) are never bindable.** This is a safety property, not a UI simplification — see Task 1.
- **Comment policy:** thick WHY comments (`CLAUDE.md`). Explain why the shape is what it is and what would make it wrong; do not narrate what the code does.
- **Command/settings copy style** (`docs/command-style.md`): stable noun phrase for the row title, no `Toggle`/`Enable` verbs.
- **The existing global keyboard path must not change.** No edits to `src/main/dictation/**`, `classifyDictationBinding`, `configureDictationHotkey`, or the Swift helper. If a task tempts you into main, the design is wrong — stop.
- **Platform:** renderer-only, so it works wherever Agent Code runs. No Accessibility permission, no macOS gate.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/renderer/src/lib/mouseBinding.ts` *(create)* | Pure vocabulary: binding name ↔ `MouseEvent.button`, coercion, display formatting. No DOM, no React. |
| `src/renderer/src/app-state/settings/types.ts` *(modify)* | `dictationMouseButton` field + default. |
| `src/renderer/src/app-state/settings/persistence.ts` *(modify)* | Coerce the persisted value so a corrupt blob cannot boot a bad binding. |
| `src/renderer/src/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry.ts` *(modify)* | Extract the press/release dispatch into two exported functions so keyboard IPC and mouse both drive the same logic. |
| `src/renderer/src/features/voice-dictation/useDictationMouseTrigger.ts` *(create)* | Root hook: window pointer listeners, hold state, the release funnel. |
| `src/renderer/src/features/settings/ui/MouseButtonInput.tsx` *(create)* | Settings capture control ("click the button you want"). |
| `src/renderer/src/features/settings/lib/settingsRegistry.ts` *(modify)* | New `mouse-button` control type + the `dictation-mouse-button` row. |
| `src/renderer/src/features/settings/ui/SettingsList.tsx` *(modify)* | Render the new control type. |
| `src/renderer/src/app/App.tsx` *(modify)* | Mount the hook beside `useDictationHotkeySync()`. |

---

### Task 1: The binding vocabulary

**Files:**
- Create: `src/renderer/src/lib/mouseBinding.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type MouseButtonBinding = '' | 'Middle' | 'Back' | 'Forward'`; `MOUSE_BUTTON_BINDINGS: Record<Exclude<MouseButtonBinding, ''>, number>`; `mouseButtonBindingFromButton(button: number): MouseButtonBinding | null`; `coerceMouseButtonBinding(value: unknown): MouseButtonBinding`; `formatMouseButtonForDisplay(value: MouseButtonBinding): string`.

- [ ] **Step 1: Create the module**

```ts
// Mouse-button dictation trigger vocabulary.
//
// WHY this is a separate module instead of a new token inside
// hotkeyBinding.ts: the two bindings have different REACH. A keyboard
// dictation binding is registered in the MAIN process — either through
// Electron's globalShortcut or through the CGEventTap helper — so it fires
// while any application is focused. A mouse binding is a plain renderer DOM
// listener and can only fire while Agent Code itself has focus. Folding
// mouse tokens into `dictationShortcut` would mean one field whose SCOPE
// silently changed depending on the value stored in it, and "my shortcut
// only works sometimes" is the bug report that produces. Two fields, two
// unambiguous meanings, and the global keyboard path stays untouched.
//
// WHY readable names in storage rather than raw MouseEvent.button integers:
// settings blobs get read by humans during support, and `4` is unreadable
// where `Forward` is not. This is the same store-the-name/match-the-physical
// -value rule that `features/command-keybindings/normalize.ts` states for
// keys (store `Alt+D`, match `event.code === 'KeyD'`).

export type MouseButtonBinding = '' | 'Middle' | 'Back' | 'Forward'

/**
 * The bindable buttons and their DOM `MouseEvent.button` values.
 *
 * Primary (0) and secondary (2) are deliberately ABSENT and must never be
 * added. The runtime listener runs at window capture phase and calls
 * `preventDefault()` + `stopPropagation()` on a match, so binding left click
 * would swallow every click in the application and binding right click would
 * swallow the context menu — including the clicks needed to reach Settings
 * and undo it. The exclusion is a safety property of the design, not a
 * simplification of the picker.
 *
 * Back/Forward are DOM buttons 3 and 4 (the X1/X2 thumb buttons). Which
 * physical thumb button reports which number varies by mouse and by driver,
 * which is exactly why the settings control captures a real press instead of
 * offering a dropdown the user would have to guess at.
 */
export const MOUSE_BUTTON_BINDINGS: Record<Exclude<MouseButtonBinding, ''>, number> = {
  Middle: 1,
  Back: 3,
  Forward: 4,
}

/** Resolve a DOM `MouseEvent.button` to a bindable name, or null when the
 *  button is one we refuse to bind (left/right) or don't recognise. */
export function mouseButtonBindingFromButton(button: number): MouseButtonBinding | null {
  for (const [name, value] of Object.entries(MOUSE_BUTTON_BINDINGS)) {
    if (value === button) return name as MouseButtonBinding
  }
  return null
}

/**
 * Normalize a persisted value. Unlike `coerceHotkeyBinding`, this IS a closed
 * enum: keyboard bindings are arbitrary user-captured physical keys, but the
 * bindable mouse buttons are a fixed three-item product decision. Anything
 * else — a typo, a hand-edited settings file, a value from a future release
 * that added a button we no longer support — falls back to '' (off) rather
 * than arming a binding whose runtime behavior we cannot predict.
 */
export function coerceMouseButtonBinding(value: unknown): MouseButtonBinding {
  if (typeof value !== 'string') return ''
  if (value in MOUSE_BUTTON_BINDINGS) return value as MouseButtonBinding
  return ''
}

/** Display label for the settings row. Says "Side Button" rather than the
 *  raw Back/Forward names because on a mouse these are physically thumb
 *  buttons — "Back" reads as a browser action, which is the one thing this
 *  binding specifically takes away. */
export function formatMouseButtonForDisplay(value: MouseButtonBinding): string {
  if (value === 'Middle') return 'Middle Button'
  if (value === 'Back') return 'Side Button (Back)'
  if (value === 'Forward') return 'Side Button (Forward)'
  return ''
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: clean.

*(Cleanup-PR note: `mouseButtonBindingFromButton` round-tripping every entry of `MOUSE_BUTTON_BINDINGS`, and `coerceMouseButtonBinding` rejecting `'Left'`/`'Right'`/`0`/`2`/`null`, are the two behaviors worth pinning when tests return.)*

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/lib/mouseBinding.ts
git commit -m "feat(dictation): add the mouse-button binding vocabulary"
```

---

### Task 2: Persist the setting

**Files:**
- Modify: `src/renderer/src/app-state/settings/types.ts` (the `dictationShortcut` field block, and `DEFAULT_SETTINGS`)
- Modify: `src/renderer/src/app-state/settings/persistence.ts` (beside `dictationShortcut: coerceHotkeyBinding(...)`)

**Interfaces:**
- Consumes: `MouseButtonBinding`, `coerceMouseButtonBinding` from Task 1.
- Produces: `settings.dictationMouseButton` readable anywhere `Settings` is.

- [ ] **Step 1: Add the type import and the field**

In `types.ts`, beside the existing dictation imports:

```ts
import type { MouseButtonBinding } from '@renderer/lib/mouseBinding'
```

Directly after the `dictationShortcut: string` field:

```ts
  /** Mouse button held to dictate, or '' for none. Separate from
   *  `dictationShortcut` because its REACH differs: the keyboard binding is
   *  registered in main and fires globally, while this one is a renderer DOM
   *  listener that only fires while Agent Code has focus. See
   *  lib/mouseBinding.ts for the full WHY. Both may be set at once; whichever
   *  the user presses starts the same hold. */
  dictationMouseButton: MouseButtonBinding
```

- [ ] **Step 2: Add the default**

Directly after `dictationShortcut: 'Cmd+Shift+D',` in `DEFAULT_SETTINGS`:

```ts
  // Off by default. Every bindable button already has a job — middle click
  // is paste/new-tab and the side buttons are history navigation — so
  // claiming one without the user asking would silently break a gesture they
  // rely on. Opt-in only.
  dictationMouseButton: '',
```

- [ ] **Step 3: Coerce on load**

In `persistence.ts`, add the import:

```ts
import { coerceMouseButtonBinding } from '@renderer/lib/mouseBinding'
```

and, immediately after the `dictationShortcut: coerceHotkeyBinding(parsed.dictationShortcut),` line:

```ts
    // WHY a closed-enum coercion here where dictationShortcut gets an open
    // one: keyboard bindings are arbitrary captured physical keys, but the
    // bindable mouse buttons are a fixed three. A persisted value outside
    // that set must fall back to off rather than arm a listener that
    // preventDefaults a button we have no contract for.
    dictationMouseButton: coerceMouseButtonBinding(parsed.dictationMouseButton),
```

- [ ] **Step 4: Type-check and run the settings suite**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: clean.

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/app-state/settings`
Expected: PASS. `retiredKeys.test.ts` asserts coercion is idempotent and surgical — a new field with a total coercion satisfies it, but run it to prove the round trip.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/types.ts src/renderer/src/app-state/settings/persistence.ts
git commit -m "feat(dictation): persist the mouse-button binding"
```

---

### Task 3: Make the registry trigger-agnostic

**Files:**
- Modify: `src/renderer/src/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `beginDictationHold(): void` and `endDictationHold(): void`, exported.

This is the load-bearing task. The press/release policy currently lives inline inside the two IPC callbacks. Extracting it is what lets the mouse reuse target-picking, press-ownership, and the interaction-owner gate instead of reimplementing them — a second copy of that policy is precisely how the two-owners bug class starts.

- [ ] **Step 1: Rename the ownership slot**

`activeTargetForKeyHold` is no longer key-specific. Rename it and its three usages to `activeTargetForHold`, and update its comment:

```ts
// Captured at press time so the release always reaches the same target —
// even if focus moved or another composer mounted between press and release.
// Shared by BOTH trigger sources (native keyboard hotkey and the in-app
// mouse button) on purpose: only one dictation can be live at a time, so a
// single ownership slot is the correct model. If both are somehow held at
// once, the first release wins and stops the recording — biasing toward
// stopping is deliberate (see the release comment below).
let activeTargetForHold: DictationTargetHandle | null = null
```

- [ ] **Step 2: Extract the two policy functions**

Add above `ensureDispatcher`:

```ts
/**
 * Begin a dictation hold from any trigger source.
 *
 * WHY this is exported rather than inlined in the IPC callback: the in-app
 * mouse trigger must make the SAME decisions — the interaction-owner gate,
 * the focused-else-most-recently-focused target pick, and the ownership
 * capture below. A second implementation of that policy would drift, and the
 * failure mode is the ugly one: two sources each believing they own the
 * recording. One decision point, two callers.
 */
export const beginDictationHold = (): void => {
  // Trigger events bypass the DOM's focus model entirely, so a focus trap or
  // a pointer-inert overlay cannot protect the composer. Consult the same
  // synchronous ownership contract as DOM input before choosing a target.
  if (hasAppInteractionOwner()) return
  const target = pickTarget()
  if (!target) return
  activeTargetForHold = target
  target.start()
}

/**
 * End a dictation hold from any trigger source.
 *
 * Deliberately does NOT consult `hasAppInteractionOwner()`. If a dialog opens
 * while the user is mid-hold, the release must still stop the recording that
 * already took ownership of the press — otherwise the mic stays open with no
 * surface able to close it. Every release path in this subsystem biases
 * toward stopping for that reason.
 */
export const endDictationHold = (): void => {
  // Hand the release to whatever target consumed the press, even if it is no
  // longer the focused leaf. A user can press, click elsewhere, then release —
  // the release must still stop the original recording. If nothing took
  // ownership (e.g. the trigger fired with zero registered tiles) fall back to
  // the current best target to drain any latent starting state.
  const target = activeTargetForHold ?? pickTarget()
  activeTargetForHold = null
  if (!target) return
  if (target.isActive() || target.isStarting()) target.stop()
}
```

- [ ] **Step 3: Reduce the IPC callbacks to calls**

`ensureDispatcher` becomes:

```ts
const ensureDispatcher = (): void => {
  if (dispatcherSubs) return
  dispatcherSubs = {
    offDown: window.api.onDictationHotkeyDown(beginDictationHold),
    offUp: window.api.onDictationHotkeyUp(endDictationHold),
  }
}
```

The explanatory comments that were inside those callbacks now live on the two functions — do not leave duplicates behind. Move the module header's mention of the IPC subscription being the only input source: it is now one of two.

- [ ] **Step 4: Fix the stale ownership reference in the unregister path**

In the cleanup returned by `registerDictationTarget`, `activeTargetForKeyHold === handle` becomes `activeTargetForHold === handle`.

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: clean — a missed rename shows up here.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry.ts
git commit -m "refactor(dictation): make the hold registry trigger-agnostic"
```

---

### Task 4: The runtime trigger

**Files:**
- Create: `src/renderer/src/features/voice-dictation/useDictationMouseTrigger.ts`
- Modify: `src/renderer/src/app/App.tsx`

**Interfaces:**
- Consumes: `MOUSE_BUTTON_BINDINGS`, `MouseButtonBinding` (Task 1); `settings.dictationEnabled`, `settings.dictationMouseButton` (Task 2); `beginDictationHold`, `endDictationHold` (Task 3).
- Produces: `useDictationMouseTrigger(): void`.

- [ ] **Step 1: Create the hook**

```ts
import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { MOUSE_BUTTON_BINDINGS } from '@renderer/lib/mouseBinding'
import type { MouseButtonBinding } from '@renderer/lib/mouseBinding'
import {
  beginDictationHold,
  endDictationHold,
} from '@renderer/workspace/tile-tree/TileLeaf/dictationHotkeyRegistry'

/**
 * Hold-to-talk on a mouse button, for the in-app case.
 *
 * WHY this is a renderer listener and not an extension of the main-process
 * hotkey path: Electron's `globalShortcut` cannot register mouse buttons at
 * all, so a global mouse trigger would have to go through the CGEventTap
 * helper — which means the Accessibility permission and a macOS-only
 * feature. The product decision was that dictation targets an Agent Code
 * composer, so capture only needs to work while Agent Code is focused. That
 * makes this a DOM listener with no permission, no native code, and no
 * platform gate.
 *
 * The upside over the keyboard path: pointer events carry REAL down and up
 * edges. `globalShortcut` has no key-up callback, which is why the quiet
 * keyboard path in main is a toggle rather than hold-to-talk (see the WHY on
 * `releaseElectronHotkeyRecording`). The mouse trigger is genuine
 * hold-to-talk.
 */
export function useDictationMouseTrigger(): void {
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationMouseButton = useAppStore(state => state.settings.dictationMouseButton)

  useEffect(() => {
    if (!dictationEnabled) return
    const boundButton =
      MOUSE_BUTTON_BINDINGS[dictationMouseButton as Exclude<MouseButtonBinding, ''>]
    // '' (off) and any value that survived coercion but is not a bindable
    // button both land here. Never install listeners for an unbound button:
    // the handlers preventDefault, so a wrong bound value would silently eat
    // a mouse gesture app-wide.
    if (boundButton === undefined) return

    // Hold state is a plain closure variable, not React state, for the same
    // reason `useComposerDictation` keeps lifecycle in refs: down and up are
    // raw DOM events that can arrive in the same frame, and a state update
    // scheduled by the down would not be visible to the up. This must be
    // synchronous.
    let holding = false

    /**
     * The single release funnel. Idempotent by the `holding` guard, because
     * several of the paths below can legitimately fire for the same hold —
     * e.g. blur and pointerup both arrive when the user releases over another
     * window.
     */
    const release = (): void => {
      if (!holding) return
      holding = false
      endDictationHold()
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== boundButton) return
      // The bound button is RESERVED. Suppressing both the default action and
      // further propagation is what keeps middle-click out of xterm's
      // X11-style paste and the side buttons out of Chromium's history
      // navigation. Canceling `pointerdown` also suppresses the compatibility
      // `mousedown`, so DOM listeners downstream never see the press either.
      event.preventDefault()
      event.stopPropagation()
      if (holding) return
      holding = true
      beginDictationHold()
    }

    const onPointerUp = (event: PointerEvent): void => {
      if (event.button !== boundButton) return
      event.preventDefault()
      event.stopPropagation()
      release()
    }

    // `auxclick` fires for non-primary buttons AFTER the pointer pair and is
    // the event Chromium actually routes to history navigation and
    // open-in-new-tab. Canceling pointerdown does not reliably suppress it,
    // so it gets its own suppressor.
    const onAuxClick = (event: MouseEvent): void => {
      if (event.button !== boundButton) return
      event.preventDefault()
      event.stopPropagation()
    }

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') release()
    }

    // WHY four release paths instead of just pointerup:
    //
    // A stuck-open microphone is the worst failure this subsystem has, and
    // the native helper carries a paragraph about exactly this for Fn. A
    // mouse button adds THREE ways to miss the up edge that a key does not
    // have: the pointer can leave the window while held (pointerup lands on
    // another window), the window can lose focus mid-hold (Cmd+Tab), and the
    // browser can cancel the pointer stream outright. Each of those gets a
    // path to `release()`. A truncated dictation is recoverable; a recording
    // that never stops is not.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', release, true)
    window.addEventListener('auxclick', onAuxClick, true)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      // Drain before unbinding. If the user changes or clears the binding
      // (or disables dictation) while holding, the up edge for the OLD
      // binding will never be delivered to anyone — same orphan-recording
      // hazard that `releaseElectronHotkeyRecording` exists to prevent on
      // the keyboard side.
      release()
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', release, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [dictationEnabled, dictationMouseButton])
}
```

- [ ] **Step 2: Mount it**

In `src/renderer/src/app/App.tsx`, add the import beside the other voice-dictation import and call it directly after `useDictationHotkeySync()`:

```ts
  useDictationHotkeySync()
  useDictationMouseTrigger()
```

- [ ] **Step 3: Type-check**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/voice-dictation/useDictationMouseTrigger.ts src/renderer/src/app/App.tsx
git commit -m "feat(dictation): hold a mouse button to talk"
```

*(Cleanup-PR note: the release funnel is the thing to pin — "blur while held stops the recording", "pointercancel while held stops the recording", "changing the binding mid-hold stops the recording", and "an unbound button installs no listeners". All four are the stuck-mic class.)*

---

### Task 5: The settings control

**Files:**
- Create: `src/renderer/src/features/settings/ui/MouseButtonInput.tsx`
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts`
- Modify: `src/renderer/src/features/settings/ui/SettingsList.tsx`

**Interfaces:**
- Consumes: `MouseButtonBinding`, `mouseButtonBindingFromButton`, `formatMouseButtonForDisplay` (Task 1); `settings.dictationMouseButton` (Task 2).
- Produces: the `mouse-button` control type in the settings registry union; the `dictation-mouse-button` row.

- [ ] **Step 1: Create the capture control**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  formatMouseButtonForDisplay,
  mouseButtonBindingFromButton,
} from '@renderer/lib/mouseBinding'
import type { MouseButtonBinding } from '@renderer/lib/mouseBinding'

type Props = {
  value: MouseButtonBinding
  onChange: (next: MouseButtonBinding) => void | Promise<void>
}

/**
 * Capture control for the dictation mouse button.
 *
 * WHY capture instead of a three-item dropdown: which physical thumb button
 * reports DOM button 3 versus 4 varies by mouse and driver, so "Back" and
 * "Forward" are not names a user can map to their own hardware by reading
 * them. Pressing the button you intend to use is the only unambiguous input.
 *
 * WHY this does not reuse `HotkeyInput`: that component captures modifier-only
 * holds with a settle timer and speaks the keyboard binding grammar — none of
 * which applies here. `CommandKeybindingsRow.tsx` already documents the same
 * non-reuse decision for the same reason.
 *
 * WHY capturing here cannot accidentally start dictation: `SettingsPage`
 * marks itself as the app interaction owner, and `beginDictationHold()`
 * refuses to start while an owner is mounted. The live trigger is inert for
 * as long as this control is on screen.
 */
export function MouseButtonInput({ value, onChange }: Props) {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const stop = useCallback(() => setCapturing(false), [])

  useEffect(() => {
    if (!capturing) return

    const onPointerDown = (event: PointerEvent) => {
      const binding = mouseButtonBindingFromButton(event.button)

      if (!binding) {
        // Left/right. A click outside the control is the standard cancel
        // gesture (same as HotkeyInput); inside, it is a user trying to bind
        // a button we refuse, and they deserve to be told why rather than
        // watching nothing happen.
        const inside = containerRef.current?.contains(event.target as Node) ?? false
        if (!inside) {
          setError(null)
          stop()
          return
        }
        setError('Left and right click stay reserved. Use the middle or a side button.')
        return
      }

      // Reserve the press so capturing a side button does not also navigate
      // history or paste into whatever is behind the settings surface.
      event.preventDefault()
      event.stopPropagation()
      setError(null)
      void Promise.resolve(onChange(binding)).then(stop)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setError(null)
      stop()
    }

    // Swallow the click that follows a captured aux press, otherwise the
    // browser still acts on it after we have committed the binding.
    const onAuxClick = (event: MouseEvent) => {
      if (!mouseButtonBindingFromButton(event.button)) return
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('auxclick', onAuxClick, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [capturing, onChange, stop])

  return (
    <div ref={containerRef} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={capturing}
          onClick={() => {
            setError(null)
            if (capturing) stop()
            else setCapturing(true)
          }}
          className={`
            min-w-0 flex-1 border px-3 py-2 text-left font-code text-[12px]
            ${capturing
              ? 'border-input-border-focus bg-row-selected-bg text-accent'
              : 'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink'}
          `}
        >
          {capturing
            ? 'Press the mouse button you want'
            : formatMouseButtonForDisplay(value) || 'Click to set a button'}
        </button>
        <button
          type="button"
          onClick={() => {
            setError(null)
            void onChange('')
          }}
          className="border border-control-border bg-control-bg px-3 py-2 text-[12px] text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink"
        >
          Off
        </button>
      </div>

      {error ? <div className="text-[11px] text-muted">{error}</div> : null}
    </div>
  )
}
```

- [ ] **Step 2: Add the control type to the registry union**

In `settingsRegistry.ts`, add the `MouseButtonBinding` type import, then add this arm to the `SettingRow` union directly after the `'hotkey'` arm:

```ts
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      metadata?: SettingMetadata
      control: {
        type: 'mouse-button'
        getValue: (settings: Settings) => MouseButtonBinding
        onChange: (ctx: SettingActionContext, value: MouseButtonBinding) => void | Promise<void>
      }
    }
```

- [ ] **Step 3: Add the row**

Directly after the `dictation-shortcut` row:

```ts
    {
      id: 'dictation-mouse-button',
      category: 'dictation',
      title: 'Dictation Mouse Button',
      description:
        'Hold a mouse button to talk and release to transcribe. Works while Agent Code is focused — no system permission needed. Only the middle and side buttons can be bound, and the bound button stops doing its normal job.',
      keywords: [
        'voice', 'dictation', 'mouse', 'button', 'middle', 'side', 'thumb',
        'hold', 'push to talk', 'binding',
      ],
      control: {
        type: 'mouse-button',
        getValue: settings => settings.dictationMouseButton,
        onChange: (ctx, value) => ctx.onChange({ dictationMouseButton: value }),
      },
    },
```

Note the title is a stable noun phrase per `docs/command-style.md` rule 1, matching its `Dictation Shortcut` sibling. No `metadata` block: app scope / immediate apply / settings storage are all correct here, and `naming.test.ts` asserts that the default is what unannotated rows get — an explicit block would be noise.

- [ ] **Step 4: Render it**

In `SettingsList.tsx`, add the import and a branch directly after the `'hotkey'` branch:

```tsx
          {control.type === 'mouse-button' ? (
            <MouseButtonInput
              value={control.getValue(settings)}
              onChange={value => control.onChange(context, value)}
            />
          ) : null}
```

- [ ] **Step 5: Type-check and run the settings suites**

Run: `npx tsc -p tsconfig.web.json --noEmit`
Expected: clean. If the union arm was added wrong, the `SettingsList` branch fails to narrow and this catches it.

Run: `NODE_ENV=test npx vitest run --project unit src/renderer/src/features/settings`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/settings/ui/MouseButtonInput.tsx src/renderer/src/features/settings/lib/settingsRegistry.ts src/renderer/src/features/settings/ui/SettingsList.tsx
git commit -m "feat(settings): capture a dictation mouse button"
```

---

### Task 6: Full verification

**Files:** none.

- [ ] **Step 1: Type-check both projects**

Run: `npx tsc -p tsconfig.node.json --noEmit && npx tsc -p tsconfig.web.json --noEmit`
Expected: both clean. `electron-vite build` and vitest do **not** type-check, so this is the real gate.

- [ ] **Step 2: Run the deterministic suite**

Run: `npm test`
Expected: PASS. `packages/claude-code-headless` `JsonlTailer.test.ts` "second tailer survives first closing" is a known environment flake (fs.watch timing, pinned submodule) — if that is the only failure, it is pre-existing and unrelated.

- [ ] **Step 3: Manual runtime check**

Run `npm run dev`, then:
1. Settings → Dictation → enable dictation, set a Deepgram key if not already set.
2. Click **Dictation Mouse Button → Click to set a button**, press a thumb button. It should read back as `Side Button (Back)` or `Side Button (Forward)`.
3. Close Settings, focus an agent composer, hold the button, speak, release. Transcript lands in the composer.
4. Hold the button, and while still holding press Cmd+Tab away. The recording must stop — this is the blur release path and the one most likely to be wrong.
5. Reopen Settings and press **Off**. The button must go back to doing its normal job.

If step 2 reads nothing when you press a thumb button, that mouse's side buttons are not reaching Chromium as DOM buttons 3/4 on this platform. That is a hardware/driver fact rather than a bug in this code; middle button is the fallback.

---

## Self-Review

**Spec coverage:** setting + persistence (Task 2), capture UI (Task 5), window listener reusing the registry (Tasks 3–4), left/right exclusion (Task 1, enforced by the map's contents), release safety (Task 4), suppressing the button's normal job (Task 4), no main-process changes (Global Constraints). All covered.

**Type consistency:** `MouseButtonBinding` is produced in Task 1 and consumed by name in Tasks 2, 4, and 5. `beginDictationHold`/`endDictationHold` are produced in Task 3 and consumed in Task 4 under those exact names. `mouseButtonBindingFromButton` and `formatMouseButtonForDisplay` are produced in Task 1 and consumed in Task 5. `MOUSE_BUTTON_BINDINGS` is produced in Task 1 and consumed in Task 4.

**Known deviation:** no new test files, per the standing repo preference recorded in Global Constraints. The four behaviors worth pinning are named inline in Tasks 1 and 4 so the planned test-cleanup PR inherits the list rather than re-deriving it.
