import type { ITerminalAddon, Terminal } from '@xterm/xterm'

type Disposable = { dispose(): void }

// The addon surface this module depends on is deliberately just the public
// lifecycle: construct, activate (through terminal.loadAddon), dispose and
// onContextLoss. Under 0.19.0 it also subscribed to the texture-atlas events
// and reached into private renderer fields to force a rebind (the
// `invalidateTextureBindings` bridge, #789). That bridge was deleted with the
// move to the 0.20.0 beta line: the atlas bugs it papered over are fixed inside
// the addon there (xterm.js #5883), and a private-field seam against a
// continuously moving beta would have been a live hazard, not just dead code.
type WebglAddonLike = ITerminalAddon & {
  onContextLoss(handler: () => void): Disposable
}

type WebglAddonModule = {
  WebglAddon: new () => WebglAddonLike
}

type TerminalAddonHost = Pick<Terminal, 'loadAddon'>

export type XtermWebglRenderer = Disposable & {
  /** Resolves true only when WebGL became the active xterm renderer. */
  ready: Promise<boolean>
}

const loadWebglAddon = async (): Promise<WebglAddonModule> => {
  const { WebglAddon } = await import('@xterm/addon-webgl')
  return { WebglAddon }
}

/**
 * Is the GPU renderer allowed to attach at all?
 *
 * YES (#871). This constant is also the one-line ROLLBACK: if glyph corruption
 * ever reappears, set it to `false` and every xterm host falls back to xterm's
 * DOM renderer — correct, slower, and already the path every failure below
 * lands on. The off path stays tested (see the suite) for exactly that reason.
 *
 * History, because this switch has now flipped twice and the reasons matter:
 *
 * - 2026-09-04 (#783, `3b885068`): WebGL added. xterm 6's DOM renderer rebuilds
 *   every dirty row's spans on each repaint, and Claude Code repaints the whole
 *   viewport inside `?2026` synchronized-output brackets, so nearly every row is
 *   dirty on every frame — on every visible raw terminal (agent terminal view,
 *   plain shells, OpenCode Terminal), multiplied by visible lanes (#768).
 *
 * - 2026-09-08 (#841, `fcf70d0a`): turned OFF. The then-pinned
 *   `@xterm/addon-webgl@0.19.0` corrupts its own texture atlas under exactly
 *   that workload (#789): garbled and interleaved glyphs, characters replaced
 *   mid-word, inverse blocks that never repair because an idle terminal renders
 *   no further frame. Upstream xterm.js #5883 (merged 2026-05-21) fixes both
 *   causes — a fresh atlas page replacing an old one AT THE SAME INDEX after a
 *   merge (undetectable by per-page version counters), and a stale vertex
 *   buffer after a mid-render merge — but ships only on the 0.20.0 beta line,
 *   whose peer range requires a beta `@xterm/xterm`. The out-of-addon bridge
 *   could reach the first bug's symptom but not the second, nor upstream's
 *   bounded retry inside `renderRows()`.
 *
 * - 2026-09-11 (#871): turned back ON by pinning EXACTLY the core + WebGL
 *   builds VS Code's lockfile resolves to (`@xterm/xterm 6.1.0-beta.304`,
 *   `@xterm/addon-webgl 0.20.0-beta.300`). `@xterm/addon-fit 0.12.0-beta.301`
 *   is the matching beta because its peer range requires the new core — VS
 *   Code itself does not use addon-fit. xterm.js publishes betas continuously
 *   from master and its largest consumer ships these, which made waiting for a
 *   stable 0.20.0 cost more than it saved.
 *
 * THE PINNED CORE IS LOCALLY PATCHED — read `scripts/patch-xterm.mjs` before
 * bumping ANY xterm package. The beta line's `resize()` flushes the write
 * queue through a `flushSync` that re-applies already-parsed chunks (duplicate
 * output, write callbacks fired twice) and drops everything queued behind an
 * empty write (upstream xterm.js #6154, not fixed as of 2026-09-11). Pane attach
 * + re-fit hits it on every pane (see that script). The postinstall patch
 * removes the flush from `resize()`, and
 * `xtermResizeFlushPatch.test.ts` fails if a bump drops it. That bug is in the
 * core, not the renderer, so flipping this switch does NOT roll it back.
 *
 * Move to stable `@xterm/xterm 6.1.0` / `@xterm/addon-webgl 0.20.0` once they
 * publish, one deliberate PR — and re-check the patch then (the script's
 * "WHEN THIS FAILS" section). Keep the pins exact until then: a caret on a
 * prerelease floats to any newer beta of the same version on the next lockfile
 * refresh, which would let an unrelated `npm install` move the core terminal
 * out from under the patch.
 */
const WEBGL_RENDERER_ENABLED = true

/**
 * Upgrade an already-open xterm from its DOM renderer to WebGL when available.
 *
 * WHY this is asynchronous: raw terminals are a secondary surface. Pulling the
 * WebGL renderer into the main renderer entry would make every feed-only window
 * pay its parse/startup cost even when it never opens xterm. The host calls this
 * immediately after `Terminal.open`, while the generation fence below makes a
 * late import harmless if React unmounts the pane first.
 *
 * WHY every failure falls back silently: WebGL can be unavailable by policy,
 * exhausted under memory pressure, or lost after sleep. The DOM renderer is
 * slower but correct. A GPU capability must never decide whether the user can
 * see or type into the provider terminal, and logging once per terminal would
 * itself become noise on a large workspace.
 */
export type XtermWebglRendererOptions = {
  /**
   * Called after the ACTIVE renderer changes while the host is alive: once
   * when WebGL takes over from the DOM renderer, and once more if a context
   * loss hands rendering back to the DOM. Hosts pass their existing
   * coalesced, ownership-gated fit scheduler.
   *
   * WHY this exists (PR #873 review): WebGL floors the measured device cell
   * width while the DOM renderer keeps it fractional, so the same column
   * count occupies a different width on each. xterm's own fallback keeps the
   * current cols/rows, so a grid fitted under WebGL becomes wider than its
   * pane under DOM and is clipped by the host's `overflow-hidden` — and the
   * hosts' ResizeObservers watch the outer container, which does not change
   * size when only the renderer does. Nothing else would ever refit.
   *
   * Never called for a renderer that never changed (disabled, import or
   * construction failure) or after the host disposed the wrapper.
   */
  onRendererChange?: () => void
  /** Test seam for the dynamic addon import; production uses the real one. */
  loadAddon?: () => Promise<WebglAddonModule>
  // WHY the gate is an option rather than read straight from the constant:
  // the constant is the rollback switch, and the suite must exercise BOTH
  // sides of it regardless of which way it currently points — the attach,
  // fallback and context-loss machinery for the on side, and the zero-cost
  // off path for the day corruption forces a rollback. A hard-coded read would
  // make whichever side is not current untestable.
  enabled?: boolean
}

export function attachXtermWebglRenderer(
  terminal: TerminalAddonHost,
  {
    onRendererChange,
    loadAddon = loadWebglAddon,
    enabled = WEBGL_RENDERER_ENABLED,
  }: XtermWebglRendererOptions = {},
): XtermWebglRenderer {
  // Bail before the dynamic import, so a disabled renderer costs nothing at
  // all: no addon parse, no GPU context, no listeners. Callers keep their
  // existing shape and simply never see WebGL become active — the same
  // observable result as a machine where WebGL is unavailable by policy, which
  // this file already had to handle correctly.
  if (!enabled) {
    return { ready: Promise.resolve(false), dispose() {} }
  }

  let disposed = false
  let addon: WebglAddonLike | null = null
  let contextLossDisposable: Disposable | null = null

  const disposeAddon = (): void => {
    const listener = contextLossDisposable
    const current = addon
    contextLossDisposable = null
    addon = null
    // Clear ownership before invoking third-party cleanup. A context-loss
    // callback can re-enter cleanup; it must never dispose the same addon twice.
    try { listener?.dispose() } catch { /* Keep host teardown progressing. */ }
    try { current?.dispose() } catch { /* GPU cleanup cannot strand the PTY host. */ }
  }

  // Tell the host its cell metrics changed. Guarded by `disposed` so a queued
  // GPU event or a late import can never make a torn-down host measure a
  // disposed terminal; the host's own error handling covers anything else, so
  // a throwing scheduler must not break the renderer state machine here.
  const notifyRendererChange = (): void => {
    if (disposed || !onRendererChange) return
    try { onRendererChange() } catch { /* A host scheduler failure cannot strand rendering. */ }
  }

  const ready = Promise.resolve().then(loadAddon)
    .then(module => {
      if (disposed) return false

      try {
        addon = new module.WebglAddon()
        contextLossDisposable = addon.onContextLoss(() => {
          // The xterm project explicitly recommends disposing the addon on
          // context loss. Disposal hands rendering back to xterm's DOM path;
          // trying to recreate immediately can loop while the GPU process is
          // still under the same pressure that evicted the first context.
          //
          // Only a fallback that actually happened is a renderer change: a
          // duplicate context-loss event queued before the listener was
          // removed finds `addon` already null and must not trigger a second
          // refit. Dispose FIRST, then notify, so the host's refit measures
          // the DOM renderer that is now active, not the one being removed.
          const wasActive = addon !== null
          disposeAddon()
          if (wasActive) notifyRendererChange()
        })
        terminal.loadAddon(addon)
        const active = addon !== null
        // The upgrade itself changes cell metrics too (DOM -> WebGL floors the
        // cell width), so the grid the host fitted under the DOM renderer is
        // stale the moment WebGL takes over.
        if (active) notifyRendererChange()
        return active
      } catch {
        disposeAddon()
        return false
      }
    })
    .catch(() => false)

  return {
    ready,
    dispose() {
      if (disposed) return
      disposed = true
      disposeAddon()
    },
  }
}
